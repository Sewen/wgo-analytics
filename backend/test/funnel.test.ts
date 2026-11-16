import { describe, expect, it } from 'vitest';
import { collapseJourney, driverRow, errorRow, MIN_SESSIONS, mergeJourneys, rankDrivers, wilson } from '../src/lib/funnel';

describe('wilson', () => {
  it('brackets the observed rate and narrows with more data', () => {
    const [lo1, hi1] = wilson(5, 10);
    const [lo2, hi2] = wilson(500, 1000);
    expect(lo1).toBeLessThan(0.5);
    expect(hi1).toBeGreaterThan(0.5);
    expect(hi2 - lo2).toBeLessThan(hi1 - lo1);
    expect(wilson(0, 0)).toEqual([0, 1]);
    expect(wilson(0, 20)[0]).toBe(0);
    expect(wilson(20, 20)[1]).toBeCloseTo(1, 10);
  });
});

describe('driverRow', () => {
  it('computes rate, lift and conversions gained or missed against the average', () => {
    const r = driverRow('entry', '/pricing', 100, 30, 0.1);
    expect(r).toMatchObject({ dim: 'entry', key: '/pricing', at: null, sessions: 100, converted: 30, rate: 0.3, baseline: 0.1 });
    expect(r.lift).toBeCloseTo(3);
    expect(r.impact).toBeCloseTo(20);
    expect(driverRow('entry', '/', 10, 0, 0).lift).toBeNull();
  });
});

describe('rankDrivers', () => {
  const p = 0.2;
  const rows = [
    driverRow('entry', '/pricing', 400, 160, p), // clearly better, +80
    driverRow('source', 'news.example', 30, 25, p), // clearly better but small, +19
    driverRow('device', 'desktop', 1000, 205, p), // average
    driverRow('entry', '/blog', 500, 40, p), // clearly worse, -60
    driverRow('error', 'TypeError: x', 60, 0, p), // clearly worse, -12
    driverRow('error', 'Checkout 500', 100, 60, p), // "converts well": errors never count as best
    driverRow('country', 'NZ', MIN_SESSIONS - 1, MIN_SESSIONS - 1, p), // too small to judge
  ];

  it('keeps segments whose interval clears the average, ordered by conversions gained or missed', () => {
    const { best, worst } = rankDrivers(rows);
    expect(best.map((r) => r.key)).toEqual(['/pricing', 'news.example']);
    expect(worst.map((r) => r.key)).toEqual(['/blog', 'TypeError: x']);
  });

  it('caps each list and finds nothing when nothing converts', () => {
    expect(rankDrivers(rows, 1).best).toHaveLength(1);
    const none = rankDrivers([driverRow('entry', '/', 100, 0, 0)]);
    expect(none).toEqual({ best: [], worst: [] });
  });
});

describe('errorRow', () => {
  const pages = new Map([['/checkout', driverRow('page', '/checkout', 200, 120, 0.1)]]);

  it('compares an error with the other sessions that viewed its page', () => {
    // 40 of the 200 /checkout sessions hit it and 8 of those converted; the other 160 converted 112 times (70%)
    const r = errorRow('POST /api/checkout 502', '/checkout', 40, 8, pages, 0.1);
    expect(r).toMatchObject({ dim: 'error', at: '/checkout', baseline: 0.7 });
    expect(r.impact).toBeCloseTo(8 - 40 * 0.7);
    // far above the 10% overall rate, yet clearly troublesome against its page
    expect(rankDrivers([r]).worst).toEqual([r]);
  });

  it('falls back to the overall rate when the page is unknown or nobody else saw it', () => {
    expect(errorRow('x', '/elsewhere', 40, 8, pages, 0.1).baseline).toBe(0.1);
    expect(errorRow('x', null, 40, 8, pages, 0.1).baseline).toBe(0.1);
    expect(errorRow('x', '/checkout', 200, 120, pages, 0.1).baseline).toBe(0.1);
  });
});

describe('journeys', () => {
  it('collapses repeated pages and keeps the first three', () => {
    expect(collapseJourney(['/', '/', '/pricing', '/pricing', '/signup', '/done'])).toEqual(['/', '/pricing', '/signup']);
    expect(collapseJourney([])).toEqual([]);
  });

  it('merges raw page lists that collapse to the same journey', () => {
    const j = mergeJourneys([
      { pages: ['/', '/pricing'], sessions: 10, converted: 1 },
      { pages: ['/', '/', '/pricing'], sessions: 5, converted: 4 },
      { pages: ['/blog'], sessions: 12, converted: 0 },
      { pages: [], sessions: 3, converted: 0 },
    ]);
    expect(j.map(({ low: _l, high: _h, ...x }) => x)).toEqual([
      { pages: ['/', '/pricing'], sessions: 15, converted: 5, rate: 5 / 15 },
      { pages: ['/blog'], sessions: 12, converted: 0, rate: 0 },
    ]);
    expect([j[0].low, j[0].high]).toEqual(wilson(5, 15));
  });
});
