import { randomBytes } from 'node:crypto';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { forgetFileLists } from './cache';
import { location } from './files';
import { dayOf, dayPrefix, TABLES, type ColType, type RawTable } from './tables';

type Row = Record<string, unknown> & { project_id: string };

const BASIC: Record<ColType, 'STRING' | 'JSON' | 'TIMESTAMP' | 'INT32' | 'INT64' | 'DOUBLE'> = {
  string: 'STRING', json: 'JSON', timestamp: 'TIMESTAMP', int: 'INT32', bigint: 'INT64', double: 'DOUBLE',
};

const toDate = (v: unknown) => (v instanceof Date ? v : new Date(v as string));

function convert(type: ColType, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'timestamp': return toDate(v);
    // the writer serializes objects itself; a string here is already JSON
    case 'json': return typeof v === 'string' ? JSON.parse(v) : v;
    case 'bigint': return BigInt(Math.trunc(Number(v)));
    case 'int': return Math.trunc(Number(v));
    case 'double': return Number(v);
    case 'string': return String(v);
  }
}

/** One Parquet file of rows (all of one table), sorted by time. */
export function encodeParquet(table: RawTable, rows: Row[]): Uint8Array {
  const def = TABLES[table];
  const t = (r: Row) => toDate(r[def.time]).getTime();
  const sorted = [...rows].sort((a, b) => t(a) - t(b));
  const buf = parquetWriteBuffer({
    columnData: def.columns.map(([name, type]) => ({ name, type: BASIC[type], data: sorted.map((r) => convert(type, r[name])) })),
    codec: 'SNAPPY',
    rowGroupSize: 100_000,
    createdBy: 'wgo',
  });
  return new Uint8Array(buf);
}

export const newFileName = (prefix = '') => `${prefix}${Date.now()}-${randomBytes(5).toString('hex')}.parquet`;

/**
 * Write rows as one new file per project and UTC day. Files are never appended to; the maintenance job merges
 * small ones (store/maintain.ts). Returns the keys written.
 */
export async function writeRows<T extends { project_id: string }>(table: RawTable, input: readonly T[]): Promise<string[]> {
  if (!input.length) return [];
  const rows = input as unknown as Row[];
  const def = TABLES[table];
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.project_id}|${dayOf(toDate(r[def.time]).getTime())}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const loc = location();
  const keys = await Promise.all([...groups].map(async ([k, list]) => {
    const [pid, day] = k.split('|');
    const key = dayPrefix(table, pid, day) + newFileName();
    await loc.put(key, encodeParquet(table, list));
    return key;
  }));
  forgetFileLists();
  return keys;
}
