import { insertRows, query } from './db';
import type { EventRow } from './events';

/**
 * Who an anonymous visitor turned out to be. When a browser's events start carrying a user id (the SDK's
 * identify(), or autoIdentify reading the app's JWT), the pair anon_id → user_id is kept here. Queries then
 * resolve `user_id` of that browser's earlier, anonymous events through it (store/duck.ts), so the events
 * before a login belong to the user too. The Parquet files are never rewritten.
 *
 * An anonymous id keeps the first user seen on it: the SDK starts a new anonymous id when another user logs in
 * on the same browser (or on reset()), so a later, different user is a leftover and must not take over.
 */

/** Pairs this container recorded recently: a logged-in user's every batch carries the same pair. */
const recorded = new Map<string, number>();
const REMEMBER_MS = 3600_000;

/** Store the anon_id → user_id pairs in freshly ingested events (first one per anonymous id wins). */
export async function recordIdentities(rows: readonly EventRow[], now = Date.now()): Promise<void> {
  const pairs = new Map<string, [string, string, string]>();
  const identified = rows.filter((r) => r.anon_id && r.user_id).sort((a, b) => +a.ts - +b.ts);
  for (const r of identified) {
    const k = `${r.project_id}|${r.anon_id}`;
    if (pairs.has(k) || (recorded.get(k) ?? 0) > now) continue;
    pairs.set(k, [r.project_id, r.anon_id!, r.user_id!]);
  }
  if (!pairs.size) return;
  await insertRows('identities', ['project_id', 'anon_id', 'user_id'], [...pairs.values()]);
  for (const k of pairs.keys()) recorded.set(k, now + REMEMBER_MS);
  if (recorded.size > 20_000) for (const [k, exp] of recorded) if (exp <= now) recorded.delete(k);
}

// ---------------------------------------------------------------- query side

/** How often a container looks for new pairs of a project. */
const REFRESH_MS = 30_000;
/** Re-read pairs this much older than the newest one seen: commits don't land in created_at order. */
const OVERLAP_MS = 120_000;

interface SyncState { next: number; since: number | null; any: boolean; pending?: Promise<boolean> }
const synced = new Map<string, SyncState>();

/**
 * Bring a container's copy of a project's pairs up to date, at most every REFRESH_MS: everything the first time,
 * then only pairs created since. `insert` adds rows to the copy, ignoring ones it already has. Returns whether
 * the project has any pairs. A failed read is logged and leaves events unresolved rather than failing the query.
 */
export function syncIdentities(pid: string, insert: (rows: Array<[string, string]>) => Promise<void>, now = Date.now()): Promise<boolean> {
  let s = synced.get(pid);
  if (!s) synced.set(pid, (s = { next: 0, since: null, any: false }));
  if (s.pending) return s.pending;
  if (now < s.next) return Promise.resolve(s.any);
  const st = s;
  st.pending = (async () => {
    try {
      const rows = st.since === null
        ? await query<{ anon_id: string; user_id: string; created_at: Date }>(
            'SELECT anon_id, user_id, created_at FROM identities WHERE project_id = $1', [pid])
        : await query<{ anon_id: string; user_id: string; created_at: Date }>(
            'SELECT anon_id, user_id, created_at FROM identities WHERE project_id = $1 AND created_at >= $2',
            [pid, new Date(st.since - OVERLAP_MS)]);
      if (rows.length) {
        await insert(rows.map((r) => [r.anon_id, r.user_id]));
        st.any = true;
        let since = st.since ?? 0;
        for (const r of rows) since = Math.max(since, new Date(r.created_at).getTime());
        st.since = since;
      }
    } catch (err) {
      console.warn('identities not loaded', (err as Error).message);
    } finally {
      st.next = Date.now() + REFRESH_MS;
      st.pending = undefined;
    }
    return st.any;
  })();
  return st.pending;
}

/** Tests: forget what was synced and recorded. */
export function forgetIdentities(): void {
  synced.clear();
  recorded.clear();
}
