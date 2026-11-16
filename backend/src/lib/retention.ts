import { execute, query } from './db';
import { getJobState, setJobState } from './jobState';
import { ROLLUP_RETENTION_DAYS } from './rollups';
import { deleteExpired } from './store/maintain';

/**
 * Raw data retention. Each project keeps its events, logs, spans and metric points (Parquet files in the data
 * bucket) for `retention_days` (default 90), capped by the stack's MaxRetentionDays. Whole days are deleted,
 * so data lives up to a day longer. Hourly rollups (DSQL) outlive raw data (ROLLUP_RETENTION_DAYS).
 */
export const DEFAULT_RETENTION_DAYS = 90;
const DAY = 86_400_000;

export function maxRetentionDays(): number {
  const n = Math.floor(Number(process.env.MAX_RETENTION_DAYS));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 3650) : 400;
}

/** Effective retention: the project's setting (or the default), never above the stack's cap. */
export const effectiveRetention = (days: number | null | undefined) => Math.min(days ?? DEFAULT_RETENTION_DAYS, maxRetentionDays());

const cache = new Map<string, { days: number; exp: number }>();
/** Effective retention of a project, cached per container for a minute. */
export async function projectRetention(pid: string): Promise<number> {
  const hit = cache.get(pid);
  if (hit && hit.exp > Date.now()) return hit.days;
  const rows = await query<{ retention_days: number | null }>('SELECT retention_days FROM projects WHERE id = $1', [pid]);
  const days = effectiveRetention(rows[0]?.retention_days);
  cache.set(pid, { days, exp: Date.now() + 60_000 });
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  return days;
}
export const forgetRetention = (pid: string) => cache.delete(pid);

async function deleteSimple(sql: string, params: unknown[], batch: number, deadline: number): Promise<boolean> {
  for (;;) {
    if (Date.now() > deadline) return false;
    if ((await execute(sql, params)) < batch) return true;
  }
}

/**
 * Daily cleanup. Raw events are only deleted once rolled up (`rolledUntil`), so a stalled rollup job
 * never loses data. Returns false when it ran out of time (the next run continues).
 */
export async function runRetention(deadline: number, rolledUntil: number, now = Date.now()): Promise<{ done: boolean; deleted: Record<string, number> }> {
  const last = await getJobState('retention');
  const deleted: Record<string, number> = {};
  if (last && now - last.getTime() < 20 * 3600_000) return { done: true, deleted };

  const projects = await query<{ id: string; retention_days: number | null }>('SELECT id, retention_days FROM projects');
  const days = new Map(projects.map((p) => [p.id, effectiveRetention(p.retention_days)]));
  const raw = await deleteExpired(projects.map((p) => p.id), (pid, table) => {
    const cutoff = now - days.get(pid)! * DAY;
    return table === 'events' ? Math.min(cutoff, rolledUntil) : cutoff;
  }, deadline);
  Object.assign(deleted, raw.deleted);
  if (!raw.done) return { done: false, deleted };
  for (const p of projects) {
    const cutoff = now - days.get(p.id)! * DAY;
    // error stacks are refreshed while their group keeps occurring, so a stale one has no events left
    const stacksDone = await deleteSimple(
      `DELETE FROM error_stacks WHERE project_id = $1 AND fingerprint IN (
         SELECT fingerprint FROM error_stacks WHERE project_id = $1 AND updated_at < $2 LIMIT 500)`,
      [p.id, new Date(cutoff)], 500, deadline,
    );
    const rollCutoff = new Date(now - ROLLUP_RETENTION_DAYS * DAY);
    const rollupsDone = stacksDone && await deleteSimple(
      `DELETE FROM rollups WHERE project_id = $1 AND (dim, hour, key) IN (
         SELECT dim, hour, key FROM rollups WHERE project_id = $1 AND hour < $2 LIMIT 500)`,
      [p.id, rollCutoff], 500, deadline,
    ) && await deleteSimple(
      `DELETE FROM rollup_sketches WHERE project_id = $1 AND hour IN (
         SELECT hour FROM rollup_sketches WHERE project_id = $1 AND hour < $2 LIMIT 500)`,
      [p.id, rollCutoff], 500, deadline,
    );
    if (!rollupsDone) return { done: false, deleted };
  }
  await setJobState('retention', new Date(now));
  return { done: true, deleted };
}
