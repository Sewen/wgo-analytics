import type { AnalyticsEvent, Filter, FilterScope, LogRecord, Span } from '../contract';
import { COLUMNS } from './filters';

/**
 * In-memory evaluation of filters, for triggers checking events, logs and spans as they arrive. Same semantics
 * as the SQL compiler in filters.ts (test/filters.pg.test.ts checks the two agree on real data). Rows are in
 * their API shape, whose keys are the built-in field names.
 */

export type MatchRow = AnalyticsEvent | LogRecord | Span;

const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;
const NUMBER_FIELDS = Object.fromEntries(
  (Object.keys(COLUMNS) as FilterScope[]).map((s) => [s, new Set(Object.entries(COLUMNS[s]).filter(([, c]) => c.type === 'number').map(([k]) => k))]),
) as Record<FilterScope, Set<string>>;

const own = (o: unknown, k: string): unknown =>
  o && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;

function resolve(row: MatchRow, field: string, scope: FilterScope): unknown {
  if (field in COLUMNS[scope]) return own(row, field);
  const dot = field.indexOf('.');
  const prefix = field.slice(0, dot), rest = field.slice(dot + 1);
  if (dot <= 0 || !rest) return undefined;
  // event props nest (props.props.plan); OTel attribute keys keep their dots (attributes.http.route)
  if (scope === 'events') return prefix === 'props' ? rest.split('.').filter(Boolean).reduce<unknown>((cur, k) => own(cur, k), own(row, 'props')) : undefined;
  return prefix === 'attributes' || prefix === 'resource' ? own(own(row, prefix), rest) : undefined;
}

/** jsonb #>> text: strings as-is, other JSON as its JSON text. */
const asText = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function matchesFilter(row: MatchRow, { field, op, value = '' }: Filter, scope: FilterScope = 'events'): boolean {
  const raw = resolve(row, field, scope);
  const text = asText(raw);
  const isNumField = NUMBER_FIELDS[scope].has(field);
  const lower = text?.toLowerCase() ?? null;
  const v = value.toLowerCase();
  switch (op) {
    case 'eq':
      return isNumField ? NUMERIC.test(value) && raw !== null && Number(raw) === Number(value) : text === value;
    case 'neq':
      return isNumField ? !NUMERIC.test(value) || raw === null || Number(raw) !== Number(value) : text !== value;
    case 'contains':
      return lower !== null && lower.includes(v);
    case 'not_contains':
      return lower === null || !lower.includes(v);
    case 'starts_with':
      return lower !== null && lower.startsWith(v);
    case 'ends_with':
      return lower !== null && lower.endsWith(v);
    case 'set':
      return !!text;
    case 'not_set':
      return !text;
    default: {
      if (text === null) return false;
      let a: number | string, b: number | string;
      if (NUMERIC.test(value)) {
        if (!isNumField && !NUMERIC.test(text)) return false; // the SQL CASE yields NULL → no match
        a = Number(text);
        b = Number(value);
      } else {
        a = text;
        b = value;
      }
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
  }
}

export const matchesAll = (row: MatchRow, filters: Filter[], scope: FilterScope = 'events') => filters.every((f) => matchesFilter(row, f, scope));
