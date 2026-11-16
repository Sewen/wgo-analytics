import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Skeleton } from '../ui/kit';
import { cn } from '../lib/format';

export function PageGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-4', className)}>{children}</div>;
}
export type SortDir = 'asc' | 'desc';
export type SortState<K extends string = string> = { key: K; dir: SortDir };
type SortValue = string | number | null | undefined;

/** Client-side sort for table rows. Clicking a new column sorts numbers descending and text ascending; clicking again flips. */
export function useSort<T, K extends string>(rows: T[] | undefined, getters: Record<K, (r: T) => SortValue>, initial: SortState<NoInfer<K>>) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    if (!rows) return rows;
    const get = getters[sort.key]; const m = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1; // nulls last either direction
      return m * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }));
    });
  }, [rows, getters, sort]);
  const onSort = (key: K) => setSort((s) => {
    if (s.key === key) return { key, dir: s.dir === 'asc' ? 'desc' : 'asc' };
    const sample = rows?.map(getters[key]).find((v) => v != null);
    return { key, dir: typeof sample === 'number' ? 'desc' : 'asc' };
  });
  return { sorted, sort, onSort };
}

/** A column is a label, or [label, className], or [label, className, sortKey] to make it sortable. */
type Col = string | [string, string] | [string, string, string];
export function TableHead({ cols, className, sort, onSort }: { cols: Col[]; className?: string; sort?: SortState; onSort?: (key: string) => void }) {
  return (
    <div className={cn('sticky top-0 z-[1] grid items-center gap-4 border-b border-line bg-[color-mix(in_srgb,var(--raised)_92%,transparent)] px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-faint backdrop-blur', className)}>
      {cols.map((c, i) => {
        const [label, cls, key] = typeof c === 'string' ? [c, undefined, undefined] : c;
        if (!key || !onSort) return <div key={i} className={cls}>{label}</div>;
        const active = sort?.key === key;
        const right = cls?.includes('text-right');
        const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
        return (
          <div key={i} className={cls} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
            <button type="button" onClick={() => onSort(key)} className={cn('group inline-flex cursor-pointer items-center gap-1 uppercase tracking-wider transition-colors hover:text-fg', right && 'flex-row-reverse', active && 'text-fg')}>
              {label}<Icon size={11} className={cn('shrink-0', !active && 'opacity-0 group-hover:opacity-60')} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
export function RowsSkeleton({ n = 8 }: { n?: number }) {
  return <div className="space-y-2 p-4">{Array.from({ length: n }, (_, i) => <Skeleton key={i} className="h-10" />)}</div>;
}
export function Dl({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-2 text-[12.5px]">
      {rows.map(([k, v]) => (v == null || v === '' ? null : <div key={k} className="contents"><dt className="text-faint">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>))}
    </dl>
  );
}
export function JsonView({ value }: { value: unknown }) {
  const s = JSON.stringify(value, null, 2)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g, (m, str, colon, lit, num) =>
      str ? (colon ? `<span class="tok-a">${str}</span>${colon}` : `<span class="tok-s">${str}</span>`) : lit ? `<span class="tok-k">${lit}</span>` : num ? `<span class="tok-n">${num}</span>` : m);
  return <pre className="overflow-x-auto rounded-lg border border-line bg-[color-mix(in_srgb,var(--bg)_60%,black)] p-3 font-mono text-[11.5px] leading-relaxed" dangerouslySetInnerHTML={{ __html: s }} />;
}
