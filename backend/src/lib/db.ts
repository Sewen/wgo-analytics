import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { Pool, type QueryResultRow } from 'pg';

/**
 * Small pool per Lambda container (parallel queries within one request, e.g. stats).
 * DSQL auth uses short-lived IAM tokens checked only at connect time, so the password is a function
 * that signs a fresh token per new connection. DSQL closes connections after 60 minutes; recycle before.
 * DATABASE_URL switches to plain PostgreSQL for local development and integration tests.
 */
let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const common = { max: 4, idleTimeoutMillis: 60_000, maxLifetimeSeconds: 45 * 60, connectionTimeoutMillis: 8000 };
  if (process.env.DATABASE_URL) {
    pool = new Pool({ ...common, connectionString: process.env.DATABASE_URL });
  } else {
    const host = process.env.DSQL_ENDPOINT;
    if (!host) throw new Error('DSQL_ENDPOINT not set');
    const signer = new DsqlSigner({ hostname: host, region: process.env.AWS_REGION });
    pool = new Pool({
      ...common,
      host,
      port: 5432,
      user: 'admin',
      database: 'postgres',
      password: () => signer.getDbConnectAdminAuthToken(),
      ssl: { rejectUnauthorized: true },
    });
  }
  pool.on('error', (err) => console.warn('idle pg client error', err.message));
  return pool;
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end();
}

const RETRYABLE = new Set([
  '40001', // serialization failure (DSQL optimistic concurrency conflict)
  'OC000', // DSQL: mutation conflict
  'OC001', // DSQL: schema changed concurrently
]);

function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === 'ECONNRESET' ||
    e?.code === 'EPIPE' ||
    /Connection terminated|Client has encountered a connection error|not queryable/i.test(e?.message ?? '')
  );
}

export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await run<T>(sql, params)).rows;
}

/** Run a statement for its effect; returns the number of rows it affected. */
export async function execute(sql: string, params: unknown[] = []): Promise<number> {
  return (await run(sql, params)).rowCount ?? 0;
}

async function run<T extends QueryResultRow>(sql: string, params: unknown[]) {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await getPool().query<T>(sql, params);
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string }).code ?? '';
      if (!isConnectionError(err) && !RETRYABLE.has(code)) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt + Math.random() * 25));
    }
  }
  throw lastErr;
}

/** DSQL caps rows modified per transaction (3,000); keep inserts well below. */
export const MAX_ROWS_PER_INSERT = 500;

/**
 * Build a multi-row INSERT ... VALUES statement.
 * `casts` optionally maps a column to a cast suffix such as '::jsonb'.
 */
export function buildInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
  casts: Record<string, string> = {},
  suffix = 'ON CONFLICT DO NOTHING',
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const ph = row.map((v, i) => {
      params.push(v);
      return `$${params.length}${casts[columns[i]] ?? ''}`;
    });
    return `(${ph.join(',')})`;
  });
  return { sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${suffix}`, params };
}

export async function insertRows(
  table: string,
  columns: string[],
  rows: unknown[][],
  casts: Record<string, string> = {},
): Promise<void> {
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
    const { sql, params } = buildInsert(table, columns, rows.slice(i, i + MAX_ROWS_PER_INSERT), casts);
    await query(sql, params);
  }
}
