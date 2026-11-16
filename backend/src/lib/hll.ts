import { createHash } from 'node:crypto';

/**
 * HyperLogLog distinct counter (precision 12: 4096 registers, ~1.6% standard error).
 * Hourly sketches of session and user ids are stored with the rollups, so a 30-day "users" count is a merge
 * of 720 small sketches instead of a count(DISTINCT) over every raw event.
 *
 * Serialized form: one format byte, then either all 4096 registers (dense), or (index uint16, value uint8)
 * triples for the non-zero ones (sparse). Most hours of most projects have few ids, so sparse is the norm.
 */
const P = 12;
const M = 1 << P;
const ALPHA = 0.7213 / (1 + 1.079 / M);
const DENSE = 1;
const SPARSE = 2;

export class Hll {
  readonly registers = new Uint8Array(M);

  add(id: string): void {
    const h = createHash('sha1').update(id).digest();
    const hi = h.readUInt32BE(0);
    const lo = h.readUInt32BE(4);
    const idx = hi >>> (32 - P);
    // rank = position of the first 1 bit in the remaining 52 bits (20 from `hi`, 32 from `lo`)
    const rest = hi & ((1 << (32 - P)) - 1);
    const rank = rest !== 0 ? Math.clz32(rest) - P + 1 : 32 - P + (lo !== 0 ? Math.clz32(lo) + 1 : 33);
    if (rank > this.registers[idx]) this.registers[idx] = rank;
  }

  merge(other: Hll): this {
    const r = this.registers;
    const o = other.registers;
    for (let i = 0; i < M; i++) if (o[i] > r[i]) r[i] = o[i];
    return this;
  }

  count(): number {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < M; i++) {
      sum += 2 ** -this.registers[i];
      if (this.registers[i] === 0) zeros++;
    }
    const estimate = (ALPHA * M * M) / sum;
    // small cardinalities: linear counting is far more accurate
    if (estimate <= 2.5 * M && zeros > 0) return Math.round(M * Math.log(M / zeros));
    return Math.round(estimate);
  }

  toBuffer(): Buffer {
    let nonZero = 0;
    for (let i = 0; i < M; i++) if (this.registers[i]) nonZero++;
    if (nonZero * 3 >= M) return Buffer.concat([Buffer.from([DENSE]), Buffer.from(this.registers)]);
    const out = Buffer.alloc(1 + nonZero * 3);
    out[0] = SPARSE;
    let o = 1;
    for (let i = 0; i < M; i++) {
      if (!this.registers[i]) continue;
      out.writeUInt16BE(i, o);
      out[o + 2] = this.registers[i];
      o += 3;
    }
    return out;
  }

  static from(buf: Buffer | Uint8Array | null | undefined): Hll {
    const h = new Hll();
    if (!buf || !buf.length) return h;
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (b[0] === DENSE && b.length === M + 1) h.registers.set(b.subarray(1));
    else if (b[0] === SPARSE) for (let o = 1; o + 2 < b.length; o += 3) h.registers[b.readUInt16BE(o)] = b[o + 2];
    else throw new Error('Unknown HLL encoding');
    return h;
  }
}
