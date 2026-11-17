/**
 * Anonymous events are attributed to the user their browser later identified as. Runs in its own schema.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/identities.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Filter } from '../src/contract';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'identities_test';

d('identities (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { normalizeBatch } = await import('../src/lib/events');
  const { storeEvents } = await import('../src/lib/store/queue');
  const { rawQuery } = await import('../src/lib/store/duck');
  const { forgetIdentities } = await import('../src/lib/identities');
  const A = await import('../src/lib/analytics');

  const pid = randomUUID();
  const now = Date.now();
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 3600_000).toISOString() };
  const ev = (t: string, ago: number, extra: object = {}) => ({ id: randomUUID(), t, ts: now - ago, s: 'sess', url: 'https://shop.test/', path: '/', ...extra });
  const store = (a: string, e: unknown[]) => storeEvents(normalizeBatch(pid, { k: 'k', a, sentAt: now, e } as never, now));
  const users = async (extra: Record<string, string> = {}) =>
    (await A.events(pid, { ...range, ...extra })).events.map((e) => [e.anonId, e.type, e.userId]).sort((x, y) => String(x).localeCompare(String(y)));
  const filter = (f: Filter[]) => ({ filters: JSON.stringify(f) });
  /** past the per-container refresh interval of the identity map */
  const later = (ms: number) => { const real = Date.now; vi.spyOn(Date, 'now').mockImplementation(() => real() + ms); };

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    forgetIdentities();
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await closeDb(); });

  it('attributes the anonymous events before a login to the user', async () => {
    await store('anon-a', [ev('pageview', 600_000), ev('click', 590_000, { d: { sel: 'a.login', tag: 'a' } })]);
    await store('anon-b', [ev('pageview', 500_000)]);
    expect(await users()).toEqual([['anon-a', 'click', null], ['anon-a', 'pageview', null], ['anon-b', 'pageview', null]]);

    // the login: from now on the SDK puts u on every event
    await store('anon-a', [ev('identify', 300_000, { u: 'alice@x.com' }), ev('pageview', 299_000, { u: 'alice@x.com' })]);
    later(31_000);
    expect(await users()).toEqual([
      ['anon-a', 'click', 'alice@x.com'], ['anon-a', 'identify', 'alice@x.com'],
      ['anon-a', 'pageview', 'alice@x.com'], ['anon-a', 'pageview', 'alice@x.com'], ['anon-b', 'pageview', null],
    ]);
    expect(await query('SELECT anon_id, user_id FROM identities WHERE project_id = $1', [pid])).toEqual([{ anon_id: 'anon-a', user_id: 'alice@x.com' }]);
  });

  it('filters and searches on the resolved user', async () => {
    later(31_000);
    const f = await users(filter([{ field: 'userId', op: 'eq', value: 'alice@x.com' }]));
    expect(f.map((r) => r[1])).toEqual(['click', 'identify', 'pageview', 'pageview']);
    expect((await users({ q: 'alice' })).length).toBe(4);
    expect(await users(filter([{ field: 'userId', op: 'not_set', value: '' }]))).toEqual([['anon-b', 'pageview', null]]);
  });

  it('keeps the first user of a browser and the user id an event carries', async () => {
    await store('anon-a', [ev('custom', 60_000, { u: 'bob@x.com', d: { name: 'later' } })]);
    later(62_000);
    const rows = await users();
    expect(rows.filter((r) => r[2] === 'bob@x.com')).toEqual([['anon-a', 'custom', 'bob@x.com']]);
    expect(rows.filter((r) => r[2] === 'alice@x.com')).toHaveLength(4);
    expect((await query('SELECT user_id FROM identities WHERE project_id = $1', [pid])).map((r) => r.user_id)).toEqual(['alice@x.com']);
  });

  it('picks up identities recorded after the map was loaded', async () => {
    await store('anon-c', [ev('pageview', 200_000)]);
    later(93_000);
    expect((await users()).filter((r) => r[0] === 'anon-c')).toEqual([['anon-c', 'pageview', null]]);
    await store('anon-c', [ev('identify', 100_000, { u: 'carol' })]);
    vi.restoreAllMocks();
    later(124_000);
    expect((await users()).filter((r) => r[0] === 'anon-c')).toEqual([['anon-c', 'identify', 'carol'], ['anon-c', 'pageview', 'carol']]);
  });

  it('leaves queries that never read user_id alone', async () => {
    const [{ n }] = await rawQuery<{ n: number }>(pid, { from: new Date(range.from), to: new Date(range.to) },
      'SELECT count(*)::int AS n FROM events WHERE project_id = $1', [pid]);
    expect(n).toBe(8);
  });
});
