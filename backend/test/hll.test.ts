import { describe, expect, it } from 'vitest';
import { Hll } from '../src/lib/hll';

const fill = (n: number, prefix = 'id') => {
  const h = new Hll();
  for (let i = 0; i < n; i++) h.add(`${prefix}-${i}`);
  return h;
};

describe('Hll', () => {
  it('is exact-ish for small counts and ignores duplicates', () => {
    const h = fill(50);
    for (let i = 0; i < 50; i++) h.add(`id-${i}`);
    expect(h.count()).toBe(50);
    expect(new Hll().count()).toBe(0);
  });

  it.each([1_000, 20_000, 200_000])('estimates %i distinct ids within 5%', (n) => {
    expect(Math.abs(fill(n).count() - n) / n).toBeLessThan(0.05);
  });

  it('merges like a union', () => {
    const a = fill(10_000, 'a');
    const b = fill(10_000, 'b');
    const overlap = fill(10_000, 'a'); // same ids as a
    const n = a.merge(b).merge(overlap).count();
    expect(Math.abs(n - 20_000) / 20_000).toBeLessThan(0.05);
  });

  it('round-trips sparse and dense encodings', () => {
    const small = fill(30);
    const big = fill(50_000);
    expect(small.toBuffer()[0]).toBe(2);
    expect(small.toBuffer().length).toBeLessThan(100);
    expect(big.toBuffer()[0]).toBe(1);
    expect(Hll.from(small.toBuffer()).registers).toEqual(small.registers);
    expect(Hll.from(big.toBuffer()).registers).toEqual(big.registers);
    expect(Hll.from(null).count()).toBe(0);
  });
});
