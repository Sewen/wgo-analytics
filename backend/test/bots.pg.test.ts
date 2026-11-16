/**
 * Bot traffic is stored but left out of analytics by default (own schema, runs alongside the other pg tests).
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/bots.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'bots_test';

d('bot traffic (PostgreSQL)', async () => {
  const url = new URL(BASE ?? 'postgres://x');
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, insertRows, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { EVENT_COLUMNS, eventRowValues, normalizeBatch } = await import('../src/lib/events');
  const A = await import('../src/lib/analytics');

  const pid = randomUUID();
  const now = Date.now();
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1';

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));
    await query('INSERT INTO projects (id, name, write_key) VALUES ($1, $2, $3)', [pid, 'Pingis', 'wk_botstest00000001']);

    const visit = (anon: string, tz: string, country: string, events: number) =>
      normalizeBatch(pid, {
        k: 'k', a: anon, sentAt: now, ctx: { ua: iphone, tz, lang: 'sv' },
        e: Array.from({ length: events }, (_, i) => ({ id: randomUUID(), t: i ? 'click' : 'pageview', ts: now - 60_000 + i, s: `s-${anon}`, url: 'https://pingis.net/player', path: '/player', d: i ? { sel: 'a', tag: 'a' } : undefined })),
      } as never, now, undefined, { country, region: null, city: null, lat: null, lon: null });
    const rows = [
      ...visit('human-1', 'Europe/Stockholm', 'SE', 3),
      ...visit('human-2', 'Europe/Stockholm', 'SE', 2),
      // five scraper "visitors": one pageview each, Shanghai time zone, proxies everywhere
      ...['DE', 'FR', 'BR', 'US', 'NL'].flatMap((c, i) => visit(`bot-${i}`, 'Asia/Shanghai', c, 1)),
    ];
    await insertRows('events', EVENT_COLUMNS, rows.map(eventRowValues), { props: '::jsonb' });
  });

  afterAll(async () => {
    await closeDb();
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('counts humans only by default, and says how many bot sessions it left out', async () => {
    const s = await A.stats(pid, range);
    expect(s.totals).toMatchObject({ users: 2, sessions: 2, pageviews: 2, clicks: 3 });
    expect(s.botSessions).toBe(5);
  });

  it('includes bots on request', async () => {
    const s = await A.stats(pid, { ...range, bots: '1' });
    expect(s.totals).toMatchObject({ users: 7, sessions: 7, pageviews: 7 });
    expect(s.botSessions).toBeUndefined();
  });

  it('applies to every product-analytics view', async () => {
    expect((await A.pages(pid, range))[0]).toMatchObject({ path: '/player', views: 2, sessions: 2 });
    expect((await A.events(pid, range)).events.every((e) => e.bot === null)).toBe(true);
    expect((await A.events(pid, { ...range, bots: '1', filters: JSON.stringify([{ field: 'bot', op: 'set' }]) })).events.map((e) => e.bot))
      .toEqual(Array(5).fill('timezone-mismatch'));
    expect(await A.breakdown(pid, { ...range, dim: 'country' })).toEqual([{ key: 'SE', count: 2 }]);
  });
});
