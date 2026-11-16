import { useMemo, useSyncExternalStore } from 'react';
import type { Filter, FilterScope } from '../api/contract';
import { filterSetKey } from './filters';

/**
 * Filter sets you've applied, per project and scope, kept in this browser: the last ones used and the most used
 * ones are a click away in the filter bar. A set counts once it has stayed applied for a moment (so building
 * one chip by chip doesn't record every intermediate step).
 */

export interface FilterUse { key: string; filters: Filter[]; count: number; last: number }

const MAX = 40;
const storageKey = (pid: string, scope: FilterScope) => `wgo.filterHistory.${pid}.${scope}`;
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; list: FilterUse[] }>();

function read(k: string): FilterUse[] {
  const raw = localStorage.getItem(k);
  const hit = cache.get(k);
  if (hit && hit.raw === raw) return hit.list; // stable identity for useSyncExternalStore
  let list: FilterUse[] = [];
  try {
    const v = JSON.parse(raw ?? '[]');
    if (Array.isArray(v)) list = v.filter((e) => e && Array.isArray(e.filters) && e.filters.length && typeof e.count === 'number');
  } catch { /* corrupt: start over */ }
  cache.set(k, { raw, list });
  return list;
}

function write(k: string, list: FilterUse[]) {
  try {
    localStorage.setItem(k, JSON.stringify(list));
  } catch { /* storage full or disabled: history is a convenience */ }
  listeners.forEach((l) => l());
}

export function recordFilterUse(pid: string, scope: FilterScope, filters: Filter[]) {
  if (!filters.length) return;
  const k = storageKey(pid, scope);
  const key = filterSetKey(filters);
  const list = read(k);
  const cur = list.find((e) => e.key === key);
  const next = [{ key, filters, count: (cur?.count ?? 0) + 1, last: Date.now() }, ...list.filter((e) => e.key !== key)];
  if (next.length > MAX) {
    // keep the most used, then the most recent
    next.sort((a, b) => b.count - a.count || b.last - a.last);
    next.length = MAX;
  }
  write(k, next);
}

export function forgetFilterUse(pid: string, scope: FilterScope, key: string) {
  const k = storageKey(pid, scope);
  write(k, read(k).filter((e) => e.key !== key));
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key?.startsWith('wgo.filterHistory.')) cb(); }; // other tabs
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage); };
}

/**
 * The last 3 sets used, and the 3 most used sets (sets used more than once; ones already listed under recent
 * are skipped so the 6 slots are distinct).
 */
export function useFilterHistory(pid: string, scope: FilterScope): { recent: FilterUse[]; frequent: FilterUse[] } {
  const k = storageKey(pid, scope);
  const list = useSyncExternalStore(subscribe, () => read(k), () => [] as FilterUse[]);
  return useMemo(() => {
    const recent = [...list].sort((a, b) => b.last - a.last).slice(0, 3);
    const seen = new Set(recent.map((e) => e.key));
    const frequent = [...list].filter((e) => e.count > 1 && !seen.has(e.key)).sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 3);
    return { recent, frequent };
  }, [list]);
}
