/**
 * Upgrading a stack that kept raw rows in DSQL: the maintenance job moves them into Parquet, deletes exactly the
 * rows it wrote, and then never runs again. Runs in its own PostgreSQL schema.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/store.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'store_test';

d('moving legacy raw rows (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, insertRows, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { moveLegacyRows, runCompaction } = await import('../src/lib/store/maintain');
  const { rawQuery } = await import('../src/lib/store/duck');
  const { writeRows } = await import('../src/lib/store/write');

  const now = Date.now();
  const all = { from: new Date(now - 30 * 86400e3), to: new Date(now + 86400e3) };
  const a = randomUUID(), b = randomUUID();

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    await query('INSERT INTO projects (id, name, write_key) VALUES ($1, $2, $3), ($4, $5, $6)', [a, 'A', 'wk_storetest000000a', b, 'B', 'wk_storetest000000b']);

    // rows as older versions stored them, some with microsecond timestamps
    const events = Array.from({ length: 1200 }, (_, i) => [
      i % 3 ? a : b, new Date(now - (i % 10) * 86400e3 - i * 1000), randomUUID(), 'pageview', `s${i % 50}`, '/p', JSON.stringify({ i }),
    ]);
    await insertRows('events', ['project_id', 'ts', 'id', 'type', 'session_id', 'path', 'props'], events, { props: '::jsonb' });
    await query(`UPDATE events SET ts = ts + interval '123 microseconds' WHERE project_id = $1`, [b]);
    await insertRows('spans', ['project_id', 'start_time', 'span_id', 'trace_id', 'name', 'kind', 'service', 'end_time', 'duration_ms', 'status_code', 'attributes'],
      [[a, new Date(now - 5000), 'ab'.repeat(8), 'cd'.repeat(16), 'GET /', 2, 'api', new Date(now - 4000), 1000, 0, JSON.stringify({ 'http.route': '/' })]], { attributes: '::jsonb' });
    await insertRows('logs', ['project_id', 'ts', 'id', 'severity_number', 'body', 'service', 'attributes', 'resource'],
      [[a, new Date(now - 1000), randomUUID(), 17, 'boom', 'api', '{}', '{}']], { attributes: '::jsonb', resource: '::jsonb' });
    await insertRows('metric_points', ['project_id', 'ts', 'id', 'name', 'type', 'service', 'value', 'count', 'attributes'],
      [[b, new Date(now - 1000), randomUUID(), 'm', 'sum', 'api', 2.5, '7', '{}']], { attributes: '::jsonb' });
  });

  afterAll(async () => {
    await closeDb();
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('moves every raw row into Parquet and empties the DSQL tables', async () => {
    const res = await moveLegacyRows(Date.now() + 60_000);
    expect(res).toEqual({ done: true, moved: { events: 1200, logs: 1, spans: 1, metric_points: 1 } });
    for (const t of ['events', 'logs', 'spans', 'metric_points']) expect(await query(`SELECT 1 FROM ${t} LIMIT 1`)).toHaveLength(0);

    const count = async (pid: string) => (await rawQuery<{ n: number; s: number }>(pid, all,
      'SELECT count(*)::int AS n, sum((props->>\'i\')::int)::int AS s FROM events WHERE project_id = $1', [pid]))[0];
    expect((await count(a)).n).toBe(800);
    expect((await count(b)).n).toBe(400);
    const [span] = await rawQuery(a, all, 'SELECT * FROM spans');
    expect(span).toMatchObject({ trace_id: 'cd'.repeat(16), attributes: { 'http.route': '/' }, duration_ms: 1000 });
    const [point] = await rawQuery(b, all, 'SELECT value, count FROM metric_points');
    expect(point).toEqual({ value: 2.5, count: 7 });
  });

  it('runs only once', async () => {
    await insertRows('logs', ['project_id', 'ts', 'id', 'severity_number', 'body', 'service'], [[a, new Date(), randomUUID(), 9, 'late', 'api']]);
    expect(await moveLegacyRows(Date.now() + 60_000)).toEqual({ done: true, moved: {} });
  });

  it('merges the many files a busy day leaves, for every project', async () => {
    for (let i = 0; i < 5; i++) await writeRows('logs', [{ project_id: b, ts: new Date(now), id: randomUUID(), severity_number: 9, body: `x${i}`, service: 'api' }]);
    const res = await runCompaction(Date.now() + 60_000, now);
    expect(res.done).toBe(true);
    expect(res.merged).toBeGreaterThanOrEqual(5);
    expect((await rawQuery<{ n: number }>(b, all, 'SELECT count(*)::int AS n FROM logs'))[0].n).toBe(5);
  });
});
