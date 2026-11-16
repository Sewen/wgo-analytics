/**
 * Goal funnels against real SQL. Uses its own schema so it can run alongside the other *.pg tests.
 *
 *   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres npx vitest run test/funnel.pg.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Filter, GoalStep } from '../src/contract';

const BASE = process.env.DATABASE_URL;
const d = BASE ? describe : describe.skip;
const SCHEMA = 'funnel_test';

d('goal funnels (PostgreSQL)', async () => {
  if (!BASE) { it.skip('needs DATABASE_URL'); return; }
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  process.env.DATABASE_URL = url.toString();

  const { query, insertRows, closeDb } = await import('../src/lib/db');
  const { SCHEMA_STATEMENTS } = await import('../src/lib/schema');
  const { EVENT_COLUMNS, eventRowValues, normalizeBatch } = await import('../src/lib/events');
  const G = await import('../src/lib/goals');
  const { goalFunnel } = await import('../src/lib/funnel');

  const pid = randomUUID();
  const now = Date.now();
  const range = { from: new Date(now - 3600_000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const chrome = 'Mozilla/5.0 (Windows NT 10.0) Chrome/131 Safari/537.36';
  const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
  const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

  const signedUp: Filter[] = [{ field: 'type', op: 'eq', value: 'custom' }, { field: 'name', op: 'eq', value: 'signup_done' }];
  const page = (path: string): Filter[] => [{ field: 'type', op: 'eq', value: 'pageview' }, { field: 'path', op: 'eq', value: path }];
  const steps: GoalStep[] = [{ name: 'Pricing', filters: page('/pricing') }, { name: 'Signup form', filters: page('/signup') }];
  let goalId = '';

  beforeAll(async () => {
    const admin = new Client({ connectionString: BASE });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    for (const sql of SCHEMA_STATEMENTS) await query(sql.replace(' ASYNC ', ' '));

    // Sessions start 10 s apart; their events 1 s apart.
    let n = 0;
    const session = (ua: string, kinds: Array<[string, string, object?]>) => {
      const s = `sess-${n}`, t0 = now - 1800_000 + n++ * 10_000;
      const e = kinds.map(([t, path, d = {}], i) => ({ id: randomUUID(), t, ts: t0 + i * 1000, s, url: `https://shop.test${path}`, path, ...d }));
      return normalizeBatch(pid, { k: 'k', a: `anon-${s}`, sentAt: now, ctx: { ua }, e } as never, now);
    };
    const pv = (path: string, ref?: string): [string, string, object] => ['pageview', path, ref ? { ref } : {}];
    const done: [string, string, object] = ['custom', '/signup', { d: { name: 'signup_done' } }];
    const typeError: [string, string, object] = ['error', '/pricing', { d: { msg: 'TypeError: plans is undefined' } }];
    const rows = [];
    // A: 40 sessions from Google onto /pricing (reloaded once), on to /signup; 30 sign up
    for (let i = 0; i < 40; i++) {
      rows.push(...session(chrome, [pv('/pricing', 'https://google.com/search'), pv('/pricing', 'https://shop.test/pricing'), pv('/signup', 'https://shop.test/pricing'), ...(i < 30 ? [done] : [])]));
    }
    // B: 40 direct sessions from /blog to /pricing; half hit an error there; 2 make it through
    for (let j = 0; j < 40; j++) {
      const ok = j >= 38;
      rows.push(...session(firefox, [pv('/blog'), pv('/pricing'), ...(j < 20 ? [typeError] : []), ...(ok ? [pv('/signup'), done] : [])]));
    }
    // R: visits the steps out of order (/signup before /pricing), then signs up: converts, but not through the funnel
    rows.push(...session(chrome, [pv('/signup'), pv('/pricing'), done]));
    // a crawler that does it all: left out unless bots=1
    rows.push(...session(googlebot, [pv('/pricing'), pv('/signup'), done]));
    await insertRows('events', EVENT_COLUMNS, rows.map(eventRowValues), { props: '::jsonb' });

    // normalizeBatch puts custom names in `name` only when d.name is set; check the fixture reads as intended
    const [{ c }] = await query<{ c: number }>(`SELECT count(*)::int AS c FROM events WHERE project_id = $1 AND name = 'signup_done'`, [pid]);
    expect(c).toBe(34);

    goalId = (await G.createGoal(pid, 'me@test.dev', { name: 'Signed up', filters: signedUp, steps })).id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it('stores, validates and clears funnel steps on the goal', async () => {
    expect((await G.findGoal(pid, goalId)).steps).toEqual(steps);
    await expect(G.updateGoal(pid, goalId, { steps: [{ name: '', filters: page('/x') }] })).rejects.toMatchObject({ status: 400 });
    await expect(G.updateGoal(pid, goalId, { steps: [{ name: 'x', filters: [] }] })).rejects.toMatchObject({ status: 400 });
    await expect(G.updateGoal(pid, goalId, { steps: Array.from({ length: 7 }, () => ({ name: 'x', filters: page('/x') })) })).rejects.toMatchObject({ status: 400 });
    const other = await G.createGoal(pid, 'me@test.dev', { name: 'No steps', filters: signedUp });
    expect(other.steps).toEqual([]);
    expect((await G.updateGoal(pid, other.id, { name: 'Renamed' })).steps).toEqual([]);
    await G.deleteGoal(pid, other.id);
    expect((await G.updateGoal(pid, goalId, { name: 'Signed up' })).steps).toEqual(steps); // untouched by other edits
  });

  it('counts the steps in order, with median times and where the rest left', async () => {
    const f = await goalFunnel(pid, goalId, range);
    expect(f.sessions).toBe(81);
    expect(f.converted).toBe(33); // R converts, outside the funnel
    expect(f.steps.map((s) => [s.name, s.sessions, s.medianSeconds])).toEqual([
      ['Pricing', 81, null],
      ['Signup form', 42, 2], // R saw /signup only before /pricing
      ['Signed up', 32, 1],
    ]);
    expect(f.steps[0].exits).toEqual([{ key: '/pricing', sessions: 39 }]);
    expect(f.steps[1].exits).toEqual([{ key: '/signup', sessions: 10 }]);
    expect(f.steps[2].exits).toEqual([]);
  });

  it('splits sessions by entry page, source, browser, pages viewed and errors hit before converting', async () => {
    const f = await goalFunnel(pid, goalId, range);
    const get = (dim: keyof typeof f.dims, key: string) => {
      const r = f.dims[dim].find((x) => x.key === key);
      return r && [r.sessions, r.converted];
    };
    expect(get('entry', '/pricing')).toEqual([40, 30]);
    expect(get('entry', '/blog')).toEqual([40, 2]);
    expect(get('source', 'google.com')).toEqual([40, 30]);
    expect(get('source', '(direct)')).toEqual([41, 3]); // internal referrers aren't sources
    expect(get('browser', 'Firefox')).toEqual([40, 2]);
    expect(get('page', '/signup')).toEqual([43, 33]);
    expect(get('page', '/blog')).toEqual([40, 2]);
    expect(get('error', 'TypeError: plans is undefined')).toEqual([20, 0]);
    // compared with the other 61 sessions that viewed /pricing (33 converted), not everyone
    const err = f.dims.error.find((x) => x.key === 'TypeError: plans is undefined')!;
    expect(err.at).toBe('/pricing');
    expect(err.baseline).toBeCloseTo(33 / 61);

    expect(f.best[0]).toMatchObject({ dim: 'page', key: '/signup' });
    expect(f.best.map((r) => `${r.dim}:${r.key}`)).toEqual(expect.arrayContaining(['entry:/pricing', 'source:google.com', 'browser:Chrome']));
    expect(f.worst.map((r) => `${r.dim}:${r.key}`)).toEqual(expect.arrayContaining(['entry:/blog', 'page:/blog', 'browser:Firefox', 'error:TypeError: plans is undefined']));
    expect(f.best.some((r) => r.dim === 'error')).toBe(false);
  });

  it('lists journeys with repeats collapsed, cut at the conversion', async () => {
    const f = await goalFunnel(pid, goalId, range);
    const j = Object.fromEntries(f.journeys.map((x) => [x.pages.join(' > '), [x.sessions, x.converted]]));
    expect(j).toEqual({
      '/pricing > /signup': [40, 30],
      '/blog > /pricing': [38, 0],
      '/blog > /pricing > /signup': [2, 2],
      '/signup > /pricing': [1, 1],
    });
  });

  it('previews unsaved steps, and narrows with the page filters and bots', async () => {
    const goalOnly = await goalFunnel(pid, goalId, { ...range, steps: '[]' });
    expect(goalOnly.steps.map((s) => [s.name, s.sessions])).toEqual([['Signed up', 33]]);
    await expect(goalFunnel(pid, goalId, { ...range, steps: 'nope' })).rejects.toMatchObject({ status: 400 });

    const ff = await goalFunnel(pid, goalId, { ...range, filters: JSON.stringify([{ field: 'browser', op: 'eq', value: 'Firefox' }]) });
    expect([ff.sessions, ff.converted]).toEqual([40, 2]);
    expect(ff.steps.map((s) => s.sessions)).toEqual([40, 2, 2]);

    const bots = await goalFunnel(pid, goalId, { ...range, bots: '1' });
    expect([bots.sessions, bots.converted]).toEqual([82, 34]);

    await expect(goalFunnel(pid, randomUUID(), range)).rejects.toMatchObject({ status: 404 });
  });
});
