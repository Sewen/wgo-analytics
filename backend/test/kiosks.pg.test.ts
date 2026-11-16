/**
 * Kiosks end to end against PostgreSQL (own schema): management API for members, the kiosk API with the
 * kiosk token (state, read-only analytics, nothing else), URL rotation and deletion, and the live WebSocket.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/kiosks.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kiosk, KioskState } from '../src/contract';

vi.mock('../src/lib/live', () => ({ putConnection: vi.fn(async () => {}), deleteConnection: vi.fn(), send: vi.fn(), setSubscription: vi.fn() }));

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'kiosks_test';

d('kiosks (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();
  process.env.USER_POOL_ID ??= 'eu-west-1_test';
  process.env.USER_POOL_CLIENT_ID ??= 'test';

  const { query, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { createProject } = await import('../src/lib/projects');
  const api = (await import('../src/handlers/api')).handler;
  const kiosk = (await import('../src/handlers/kiosk')).handler;
  const ws = (await import('../src/handlers/ws')).handler;
  const { putConnection } = await import('../src/lib/live');

  const OWNER = 'owner@example.com';
  let pid = '';

  type Res = APIGatewayProxyStructuredResultV2;
  const ev = (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; query?: Record<string, string>; email?: string } = {}) =>
    ({
      rawPath: path,
      headers: opts.headers ?? {},
      queryStringParameters: opts.query,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      isBase64Encoded: false,
      requestContext: { http: { method }, authorizer: { jwt: { claims: { email: opts.email ?? OWNER } } } },
    }) as unknown as APIGatewayProxyEventV2;
  const call = async <T = any>(method: string, path: string, opts: Parameters<typeof ev>[2] = {}) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = (await api(ev(method, path, opts) as never)) as Res;
    return { status: r.statusCode!, body: JSON.parse(r.body as string) as T };
  };
  const screen = async <T = any>(token: string | undefined, path: string, q?: Record<string, string>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = (await kiosk(ev('GET', path, { headers: token ? { authorization: `Bearer ${token}` } : {}, query: q }))) as Res;
    return { status: r.statusCode!, body: JSON.parse(r.body as string) as T };
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    pid = (await createProject(OWNER, 'Shop')).id;
  });
  afterAll(async () => closeDb());

  let k: Kiosk;

  it('lets members create, list and update kiosks', async () => {
    const created = await call<Kiosk>('POST', `/api/projects/${pid}/kiosks`, { body: { name: 'Office TV' } });
    expect(created.status).toBe(200);
    k = created.body;
    expect(k).toMatchObject({ name: 'Office TV', createdBy: OWNER, lastSeenAt: null, reloadAt: null, config: { screens: [{ page: 'overview', params: 'range=24h' }], theme: 'dark' } });
    expect(k.token).toMatch(/^ks_[A-Za-z0-9]{40}$/);

    const list = await call<Kiosk[]>('GET', `/api/projects/${pid}/kiosks`);
    expect(list.body.map((x) => x.id)).toEqual([k.id]);

    const upd = await call<Kiosk>('PATCH', `/api/projects/${pid}/kiosks/${k.id}`, {
      body: { name: 'Support wall', config: { screens: [{ page: 'errors', params: 'range=1h' }, { page: 'logs', params: 'severity=17' }], rotateSeconds: 20 }, reload: true },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('Support wall');
    expect(upd.body.config.screens.map((s) => s.page)).toEqual(['errors', 'logs']);
    expect(upd.body.config.rotateSeconds).toBe(20);
    expect(upd.body.reloadAt).not.toBeNull();
    k = upd.body;

    expect((await call('PATCH', `/api/projects/${pid}/kiosks/${k.id}`, { body: { config: { screens: [{ page: 'settings' }] } } })).status).toBe(400);
  });

  it('keeps kiosks to project members', async () => {
    expect((await call('GET', `/api/projects/${pid}/kiosks`, { email: 'stranger@example.com' })).status).toBe(404);
    expect((await call('POST', `/api/projects/${pid}/kiosks`, { email: 'stranger@example.com', body: { name: 'x' } })).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${pid}/kiosks/${randomUUID()}`)).status).toBe(404);
  });

  it('serves the screen its state and records that it is alive', async () => {
    const s = await screen<KioskState>(k.token, '/kiosk/v1/state', { w: '1920', h: '1080' });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ kiosk: { id: k.id, name: 'Support wall' }, project: { id: pid, name: 'Shop' }, reloadAt: k.reloadAt });
    expect(s.body.config.screens).toHaveLength(2);
    const [row] = await call<Kiosk[]>('GET', `/api/projects/${pid}/kiosks`).then((r) => r.body);
    expect(row.display).toBe('1920×1080');
    expect(row.lastSeenAt).not.toBeNull();

    // the version changes when a member edits the kiosk, so the screen knows to re-apply
    await call('PATCH', `/api/projects/${pid}/kiosks/${k.id}`, { body: { config: { theme: 'light' } } });
    const s2 = await screen<KioskState>(k.token, '/kiosk/v1/state');
    expect(s2.body.version).not.toBe(s.body.version);
    expect(s2.body.config.theme).toBe('light');
  });

  it('serves read-only analytics for its own project and nothing else', async () => {
    const from = new Date(Date.now() - 3600_000).toISOString(), to = new Date().toISOString();
    const stats = await screen(k.token, '/kiosk/v1/stats', { from, to });
    expect(stats.status).toBe(200);
    expect(stats.body.totals).toBeDefined();
    expect((await screen(k.token, '/kiosk/v1/metrics', { from, to })).status).toBe(200);

    for (const path of ['/kiosk/v1/members', '/kiosk/v1/kiosks', '/kiosk/v1/triggers', '/kiosk/v1/rotate-key', '/kiosk/v1/constructor', '/kiosk/v1', '/api/me']) {
      expect((await screen(k.token, path)).status, path).toBe(404);
    }
    const post = (await kiosk({ ...ev('POST', '/kiosk/v1/state', { headers: { authorization: `Bearer ${k.token}` } }) })) as Res;
    expect(post.statusCode).toBe(405);
    expect((await screen(undefined, '/kiosk/v1/state')).status).toBe(401);
    expect((await screen('ks_' + 'x'.repeat(40), '/kiosk/v1/state')).status).toBe(401);
    expect((await screen(k.token.slice(0, -1), '/kiosk/v1/state')).status).toBe(401);
  });

  it('lets a kiosk open the live WebSocket for its project only', async () => {
    const connect = (q: Record<string, string>) =>
      ws({ requestContext: { routeKey: '$connect', connectionId: 'c1', domainName: 'x', stage: 'live' }, queryStringParameters: q } as never) as Promise<Res>;
    expect((await connect({ kiosk: k.token })).statusCode).toBe(200);
    expect(putConnection).toHaveBeenCalledWith('c1', pid, `kiosk:${k.id}`);
    expect((await connect({ kiosk: 'ks_' + 'y'.repeat(40) })).statusCode).toBe(401);
  });

  it('stops the old URL when it is rotated, and every URL when the kiosk is deleted', async () => {
    const old = k.token;
    const rotated = await call<Kiosk>('POST', `/api/projects/${pid}/kiosks/${k.id}/rotate`);
    expect(rotated.body.token).not.toBe(old);
    expect((await screen(old, '/kiosk/v1/state')).status).toBe(401);
    expect((await screen(rotated.body.token, '/kiosk/v1/state')).status).toBe(200);

    expect((await call('DELETE', `/api/projects/${pid}/kiosks/${k.id}`)).body).toEqual({ ok: true });
    expect((await screen(rotated.body.token, '/kiosk/v1/state')).status).toBe(401);
    expect((await call<Kiosk[]>('GET', `/api/projects/${pid}/kiosks`)).body).toEqual([]);
  });
});
