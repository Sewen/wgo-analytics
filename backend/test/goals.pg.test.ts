/**
 * Conversion goals against real SQL. Uses its own schema so it can run alongside the other *.pg tests.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/goals.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Filter } from '../src/contract';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'goals_test';

d('conversion goals (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, closeDb } = await import('../src/lib/db');
  const { writeRows } = await import('../src/lib/store/write');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { normalizeBatch } = await import('../src/lib/events');
  const G = await import('../src/lib/goals');

  const pid = randomUUID();
  const other = randomUUID();
  const now = Date.now();
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const chrome = 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36';
  const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
  const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

  const checkout: Filter[] = [{ field: 'type', op: 'eq', value: 'custom' }, { field: 'name', op: 'eq', value: 'checkout' }];
  const signup: Filter[] = [{ field: 'trackName', op: 'eq', value: 'signup' }];
  const pricing: Filter[] = [{ field: 'type', op: 'eq', value: 'pageview' }, { field: 'path', op: 'eq', value: '/pricing' }];
  const proPlan: Filter[] = [{ field: 'props.props.plan', op: 'eq', value: 'pro' }];
  const nothing: Filter[] = [{ field: 'path', op: 'eq', value: '/never' }];

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));

    let n = 0;
    const ev = (s: string, t: string, path: string, d: object = {}) =>
      ({ id: randomUUID(), t, ts: now - 600_000 + (n++) * 1000, s, url: `https://shop.test${path}`, path, d });
    const batch = (a: string, ua: string, e: unknown[]) => ({ k: 'k', a, sentAt: now, ctx: { ua }, e });
    const rows = [
      // sess-a: views pricing, signs up, checks out twice (pro)
      ...normalizeBatch(pid, batch('anon-1', chrome, [
        ev('sess-a', 'pageview', '/pricing'),
        ev('sess-a', 'click', '/pricing', { sel: 'button.signup', tag: 'button', text: 'Sign up', name: 'signup' }),
        ev('sess-a', 'custom', '/checkout', { name: 'checkout', props: { plan: 'pro' } }),
        ev('sess-a', 'custom', '/checkout', { name: 'checkout', props: { plan: 'pro' } }),
      ]) as never, now),
      // sess-b: signs up from the home page
      ...normalizeBatch(pid, batch('anon-2', firefox, [
        ev('sess-b', 'pageview', '/'),
        ev('sess-b', 'click', '/', { sel: 'button.signup', tag: 'button', text: 'Sign up', name: 'signup' }),
      ]) as never, now),
      // sess-c: reads the docs, converts nothing
      ...normalizeBatch(pid, batch('anon-3', chrome, [ev('sess-c', 'pageview', '/docs')]) as never, now),
      // a crawler that triggers the checkout event: left out unless bots=1
      ...normalizeBatch(pid, batch('anon-bot', googlebot, [ev('sess-bot', 'custom', '/checkout', { name: 'checkout' })]) as never, now),
      // another project's conversions never leak in
      ...normalizeBatch(other, batch('anon-x', chrome, [ev('sess-x', 'custom', '/checkout', { name: 'checkout' })]) as never, now),
    ];
    await writeRows('events', rows);
  });

  afterAll(async () => {
    await closeDb();
  });

  it('creates, lists, updates and deletes goals, validating input', async () => {
    const g = await G.createGoal(pid, 'me@test.dev', { name: '  Checkout ', filters: checkout });
    expect(g).toMatchObject({ name: 'Checkout', filters: checkout, createdBy: 'me@test.dev' });
    await expect(G.createGoal(pid, 'me@test.dev', { name: 'x', filters: [] })).rejects.toMatchObject({ status: 400 });
    await expect(G.createGoal(pid, 'me@test.dev', { name: '', filters: checkout })).rejects.toMatchObject({ status: 400 });
    await expect(G.createGoal(pid, 'me@test.dev', { name: 'x', filters: [{ field: 'nope', op: 'eq', value: '1' }] })).rejects.toMatchObject({ status: 400 });
    await expect(G.createGoal(pid, 'me@test.dev', { name: 'x', filters: [{ field: 'body', op: 'eq', value: '1' }] })).rejects.toMatchObject({ status: 400 }); // a logs field

    const renamed = await G.updateGoal(pid, g.id, { name: 'Purchase' });
    expect(renamed).toMatchObject({ id: g.id, name: 'Purchase', filters: checkout });
    expect((await G.listGoals(pid)).map((x) => x.name)).toEqual(['Purchase']);
    expect(await G.listGoals(other)).toEqual([]);
    await expect(G.updateGoal(other, g.id, { name: 'stolen' })).rejects.toMatchObject({ status: 404 });

    await G.deleteGoal(pid, g.id);
    expect(await G.listGoals(pid)).toEqual([]);
    await expect(G.deleteGoal(pid, g.id)).rejects.toMatchObject({ status: 404 });
  });

  it('answers with just the session totals when there are no goals', async () => {
    expect(await G.conversions(pid, range)).toEqual({ sessions: 3, users: 3, goals: [] });
  });

  it('counts conversions, converting sessions and users per goal in one pass', async () => {
    await query('DELETE FROM goals WHERE project_id = $1', [pid]);
    for (const [name, filters] of [['Checkout', checkout], ['Signup', signup], ['Pricing', pricing], ['Pro plan', proPlan], ['Never', nothing]] as const) {
      await G.createGoal(pid, 'me@test.dev', { name, filters: [...filters] });
    }
    const c = await G.conversions(pid, range);
    expect(c.sessions).toBe(3);
    const by = Object.fromEntries(c.goals.map((g) => [g.name, { conversions: g.conversions, sessions: g.sessions, users: g.users }]));
    expect(by).toEqual({
      Checkout: { conversions: 2, sessions: 1, users: 1 },
      Signup: { conversions: 2, sessions: 2, users: 2 },
      Pricing: { conversions: 1, sessions: 1, users: 1 },
      'Pro plan': { conversions: 2, sessions: 1, users: 1 },
      Never: { conversions: 0, sessions: 0, users: 0 },
    });
    for (const g of c.goals) {
      expect(g.series).toHaveLength(24);
      expect(g.series.reduce((a, b) => a + b, 0)).toBe(g.conversions);
    }
    expect(c.goals.map((g) => g.name)).toEqual(['Checkout', 'Signup', 'Pricing', 'Pro plan', 'Never']); // creation order
  });

  it('applies the page filters to both sides of the rate, and includes bots only when asked', async () => {
    const chromeOnly = await G.conversions(pid, { ...range, filters: JSON.stringify([{ field: 'browser', op: 'eq', value: 'Chrome' }]) });
    expect(chromeOnly.sessions).toBe(2);
    expect(chromeOnly.goals.find((g) => g.name === 'Signup')).toMatchObject({ sessions: 1, conversions: 1 });

    const withBots = await G.conversions(pid, { ...range, bots: '1' });
    expect(withBots.sessions).toBe(4);
    expect(withBots.goals.find((g) => g.name === 'Checkout')).toMatchObject({ sessions: 2, conversions: 3 });

    const noSeries = await G.conversions(pid, { ...range, series: '0' });
    expect(noSeries.goals.every((g) => g.series.length === 0)).toBe(true);

    const before = await G.conversions(pid, { from: new Date(now - 7200_000).toISOString(), to: new Date(now - 3600_000).toISOString() });
    expect(before.sessions).toBe(0);
    expect(before.goals.every((g) => g.conversions === 0 && g.sessions === 0)).toBe(true);
  });
});
