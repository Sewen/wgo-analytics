/**
 * Rich filters against real SQL. Uses its own schema so it can run alongside integration.pg.test.ts
 * (which drops and recreates the public tables).
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/filters.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Filter } from '../src/contract';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'filters_test';

d('rich filters (PostgreSQL)', async () => {
  // describe.skip still runs this body to collect the tests, so bail out before touching the database
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  // point this worker's pool at a private schema before the db module is loaded
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { normalizeBatch } = await import('../src/lib/events');
  const { normalizeLogs, normalizeTraces } = await import('../src/lib/otlp/normalize');
  const A = await import('../src/lib/analytics');

  const pid = randomUUID();
  const now = Date.now();
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const q = (filters: Filter[], extra: Record<string, string> = {}) => ({ ...range, ...extra, filters: JSON.stringify(filters) });

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));

    const ev = (t: string, d: object, extra: object = {}) => ({ id: randomUUID(), t, ts: now - 60_000, s: 'sess-a', url: 'https://shop.test/cart', path: '/cart', d, ...extra });
    const batch = (a: string, ua: string, e: unknown[]) => ({ k: 'k', a, sentAt: now, ctx: { ua }, e });
    const chrome = 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36';
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
    const rows = [
      ...normalizeBatch(pid, batch('anon-1', chrome, [
        ev('pageview', {}),
        ev('click', { sel: 'button.buy', tag: 'button', text: 'Buy now', name: 'buy' }),
        ev('custom', { name: 'checkout', props: { plan: 'pro', value: 120, coupon: 'SUMMER' } }),
        ev('http_error', { method: 'POST', url: 'https://api.shop.test/orders/1', status: 503, dur: 900 }),
        ev('http_error', { method: 'GET', url: 'https://api.shop.test/cart', status: 404, dur: 50 }),
      ]) as never, now),
      ...normalizeBatch(pid, batch('anon-2', firefox, [
        ev('pageview', {}, { s: 'sess-b', path: '/docs/getting-started', url: 'https://shop.test/docs/getting-started' }),
        ev('custom', { name: 'checkout', props: { plan: 'free', value: 0 } }, { s: 'sess-b' }),
        ev('click', { sel: 'a.docs', tag: 'a', text: 'Read the docs' }, { s: 'sess-b', path: '/docs/getting-started' }),
      ]) as never, now),
    ];
    await writeRows('events', rows);

    const attrs = (o: Record<string, string | number>) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } }));
    const ns = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
    const res = (svc: string) => ({ attributes: attrs({ 'service.name': svc, 'service.version': svc === 'api' ? '2.1.0' : '1.0.0' }) });
    const logs = normalizeLogs(pid, { resourceLogs: [{ resource: res('api'), scopeLogs: [{ logRecords: [
      { timeUnixNano: ns(now - 30_000), severityNumber: 17, body: { stringValue: 'payment failed' }, attributes: attrs({ 'http.route': '/orders', 'order.total': 120 }) },
      { timeUnixNano: ns(now - 20_000), severityNumber: 9, body: { stringValue: 'all good' }, attributes: attrs({ 'http.route': '/health' }) },
    ] }] }] });
    await writeRows('logs', logs);

    const span = (traceId: string, spanId: string, name: string, dur: number, a: Record<string, string | number>, parent?: string) =>
      ({ traceId, spanId, parentSpanId: parent, name, kind: 2, startTimeUnixNano: ns(now - 10_000), endTimeUnixNano: ns(now - 10_000 + dur), attributes: attrs(a), status: { code: 0 } });
    const t1 = 'a'.repeat(32), t2 = 'b'.repeat(32);
    const spans = normalizeTraces(pid, { resourceSpans: [
      { resource: res('api'), scopeSpans: [{ spans: [span(t1, '1'.repeat(16), 'POST /orders', 800, { 'http.route': '/orders', 'http.status_code': 500 }), span(t2, '2'.repeat(16), 'GET /health', 5, { 'http.route': '/health', 'http.status_code': 200 })] }] },
      { resource: res('db'), scopeSpans: [{ spans: [span(t1, '3'.repeat(16), 'INSERT orders', 300, { 'db.system': 'postgresql' }, '1'.repeat(16))] }] },
    ] });
    await writeRows('spans', spans);
  });

  afterAll(async () => {
    await closeDb();
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('filters the events list on built-in fields with every kind of operator', async () => {
    const types = async (f: Filter[]) => (await A.events(pid, q(f))).events.map((e) => e.type).sort();
    expect(await types([{ field: 'type', op: 'eq', value: 'click' }])).toEqual(['click', 'click']);
    expect(await types([{ field: 'type', op: 'neq', value: 'click' }])).toHaveLength(6);
    expect(await types([{ field: 'path', op: 'starts_with', value: '/DOCS' }])).toEqual(['click', 'pageview']); // case-insensitive
    expect(await types([{ field: 'path', op: 'ends_with', value: 'started' }])).toEqual(['click', 'pageview']);
    expect(await types([{ field: 'elementText', op: 'contains', value: 'buy' }])).toEqual(['click']);
    expect(await types([{ field: 'elementText', op: 'not_contains', value: 'buy' }])).toHaveLength(7); // includes rows without text
    expect(await types([{ field: 'httpStatus', op: 'gte', value: '500' }])).toEqual(['http_error']);
    expect(await types([{ field: 'httpStatus', op: 'lt', value: '500' }])).toEqual(['http_error']);
    expect(await types([{ field: 'durationMs', op: 'gt', value: '100' }, { field: 'httpMethod', op: 'eq', value: 'POST' }])).toEqual(['http_error']);
    expect(await types([{ field: 'trackName', op: 'set' }])).toEqual(['click']);
    expect(await types([{ field: 'browser', op: 'eq', value: 'Firefox' }])).toHaveLength(3);
  });

  it('filters on event properties, nested and numeric', async () => {
    const names = async (f: Filter[]) => (await A.events(pid, q(f))).events.map((e) => e.props as Record<string, unknown>);
    expect(await names([{ field: 'props.props.plan', op: 'eq', value: 'pro' }])).toHaveLength(1);
    expect(await names([{ field: 'props.props.value', op: 'gt', value: '100' }])).toHaveLength(1);
    expect(await names([{ field: 'props.props.value', op: 'lte', value: '0' }])).toHaveLength(1);
    expect(await names([{ field: 'props.props.coupon', op: 'not_set' }, { field: 'type', op: 'eq', value: 'custom' }])).toHaveLength(1);
    // numeric comparison against a non-numeric string value never errors
    expect(await names([{ field: 'props.props.plan', op: 'gt', value: '5' }])).toHaveLength(0);
  });

  it('applies the same filters to aggregates', async () => {
    const stats = await A.stats(pid, q([{ field: 'browser', op: 'eq', value: 'Firefox' }]));
    expect(stats.totals).toMatchObject({ events: 3, pageviews: 1, clicks: 1, sessions: 1, users: 1 });
    expect((await A.clicks(pid, q([{ field: 'path', op: 'contains', value: 'docs' }]))).map((c) => c.selector)).toEqual(['a.docs']);
    expect((await A.httpErrors(pid, q([{ field: 'httpStatus', op: 'gte', value: '500' }]))).map((h) => h.status)).toEqual([503]);
    expect(await A.breakdown(pid, q([{ field: 'path', op: 'starts_with', value: '/docs' }], { dim: 'browser' }))).toEqual([{ key: 'Firefox', count: 1 }]);
    expect((await A.pages(pid, q([{ field: 'browser', op: 'eq', value: 'Chrome' }]))).map((p) => p.path)).toEqual(['/cart']);
  });

  it('filters logs and traces on OpenTelemetry attributes and resource', async () => {
    const lg = await A.logs(pid, q([{ field: 'attributes.http.route', op: 'eq', value: '/orders' }]));
    expect(lg.logs.map((l) => l.body)).toEqual(['payment failed']);
    expect((await A.logs(pid, q([{ field: 'attributes.order.total', op: 'gte', value: '100' }]))).logs).toHaveLength(1);
    expect((await A.logs(pid, q([{ field: 'severityNumber', op: 'gte', value: '17' }]))).logs).toHaveLength(1);

    // a trace matches when any of its spans does
    const tr = await A.traces(pid, q([{ field: 'attributes.db.system', op: 'eq', value: 'postgresql' }]));
    expect(tr.map((t) => t.rootName)).toEqual(['POST /orders']);
    expect(tr[0].spanCount).toBe(2);
    expect((await A.traces(pid, q([{ field: 'resource.service.version', op: 'starts_with', value: '2.' }]))).map((t) => t.rootName).sort()).toEqual(['GET /health', 'POST /orders']);
    expect((await A.traces(pid, q([{ field: 'durationMs', op: 'lt', value: '10' }]))).map((t) => t.rootName)).toEqual(['GET /health']);
    expect((await A.services(pid, q([{ field: 'attributes.http.status_code', op: 'gte', value: '500' }]))).map((s) => s.service)).toEqual(['api']);
  });

  it('discovers fields and suggests values', async () => {
    const f = await A.fields(pid, { ...range, scope: 'events' });
    expect(f.builtin.map((x) => x.field)).toEqual(expect.arrayContaining(['path', 'httpStatus', 'country']));
    expect(f.discovered.map((x) => x.field)).toEqual(expect.arrayContaining(['props.name', 'props.props.plan', 'props.props.value', 'props.status']));
    const lf = await A.fields(pid, { ...range, scope: 'logs' });
    expect(lf.discovered.map((x) => x.field)).toEqual(expect.arrayContaining(['attributes.http.route', 'attributes.order.total', 'resource.service.name']));

    expect((await A.fieldValues(pid, { ...range, scope: 'events', field: 'props.props.plan' })).values.map((v) => v.value).sort()).toEqual(['free', 'pro']);
    expect((await A.fieldValues(pid, { ...range, scope: 'events', field: 'path', q: 'doc' })).values).toEqual([{ value: '/docs/getting-started', count: 2 }]);
    expect((await A.fieldValues(pid, { ...range, scope: 'spans', field: 'attributes.http.route' })).values.map((v) => v.value).sort()).toEqual(['/health', '/orders']);
  });

  it('rejects unknown fields and bad scopes with 400s', async () => {
    await expect(A.events(pid, q([{ field: 'nope', op: 'eq', value: '1' }]))).rejects.toMatchObject({ status: 400 });
    await expect(A.fields(pid, { ...range, scope: 'tables' })).rejects.toMatchObject({ status: 400 });
  });
});
