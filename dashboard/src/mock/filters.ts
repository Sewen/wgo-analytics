import type { AnalyticsEvent, FieldsResponse, FieldValuesResponse, Filter, FilterScope, LogRecord } from '../api/contract';

/** Mock-mode mirror of backend/src/lib/filters.ts semantics (applied in memory). */

const NUMBER_FIELDS = new Set(['httpStatus', 'durationMs', 'lat', 'lon', 'severityNumber', 'statusCode', 'kind']);
const BUILTIN: Record<FilterScope, string[]> = {
  events: ['type', 'path', 'url', 'title', 'referrer', 'selector', 'elementText', 'elementTag', 'trackName', 'errorMessage', 'errorSource', 'fingerprint',
    'httpMethod', 'httpUrl', 'httpRoute', 'httpStatus', 'durationMs', 'name', 'sessionId', 'anonId', 'userId', 'browser', 'os', 'device', 'country', 'region', 'city', 'lat', 'lon'],
  logs: ['body', 'service', 'severityText', 'severityNumber', 'traceId', 'spanId'],
  spans: ['name', 'service', 'durationMs', 'statusCode', 'statusMessage', 'kind', 'traceId', 'spanId'],
};

function get(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const k of path) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
  return cur;
}

/** Resolve a filter field on an event / log record. */
function valueOf(scope: FilterScope, row: Record<string, unknown>, field: string): unknown {
  if (field.startsWith('props.')) return get(row.props, field.slice(6).split('.'));
  if (field.startsWith('attributes.')) return (row.attributes as Record<string, unknown> | undefined)?.[field.slice(11)];
  if (field.startsWith('resource.')) return (row.resource as Record<string, unknown> | undefined)?.[field.slice(9)];
  return BUILTIN[scope].includes(field) ? row[field] : undefined;
}

const NUM = /^\s*-?\d+(\.\d+)?\s*$/;

export function matches(scope: FilterScope, row: object, filters: Filter[]): boolean {
  return filters.every(({ field, op, value = '' }) => {
    const raw = valueOf(scope, row as Record<string, unknown>, field);
    const text = raw === null || raw === undefined ? null : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    const lower = text?.toLowerCase() ?? null;
    const v = value.toLowerCase();
    switch (op) {
      case 'eq': return text === value;
      case 'neq': return text !== value;
      case 'contains': return lower !== null && lower.includes(v);
      case 'not_contains': return lower === null || !lower.includes(v);
      case 'starts_with': return lower !== null && lower.startsWith(v);
      case 'ends_with': return lower !== null && lower.endsWith(v);
      case 'set': return !!text;
      case 'not_set': return !text;
      default: {
        if (text === null) return false;
        const numeric = NUM.test(value);
        const a: number | string = numeric ? (NUM.test(text) ? Number(text) : NaN) : text;
        const b: number | string = numeric ? Number(value) : value;
        if (typeof a === 'number' && Number.isNaN(a)) return false;
        return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
      }
    }
  });
}

export function parse(raw: string | undefined): Filter[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function flattenKeys(value: unknown, prefix: string, out: Map<string, number>, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 1) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = `${prefix}${k}`;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenKeys(v, key + '.', out, depth + 1);
    else out.set(key, (out.get(key) ?? 0) + 1);
  }
}

export function fields(scope: FilterScope, sample: Array<AnalyticsEvent | LogRecord>): FieldsResponse {
  const seen = new Map<string, number>();
  for (const row of sample) {
    if ('props' in row) flattenKeys(row.props, 'props.', seen);
    if ('attributes' in row) { flattenKeys(row.attributes, 'attributes.', seen, 1); flattenKeys(row.resource, 'resource.', seen, 1); }
  }
  return {
    builtin: BUILTIN[scope].map((field) => ({ field, type: NUMBER_FIELDS.has(field) ? 'number' : 'text' })),
    discovered: [...seen].sort((a, b) => b[1] - a[1]).map(([field, count]) => ({ field, type: 'json', count })),
  };
}

export function values(scope: FilterScope, sample: object[], field: string, q?: string): FieldValuesResponse {
  const counts = new Map<string, number>();
  for (const row of sample) {
    const raw = valueOf(scope, row as Record<string, unknown>, field);
    if (raw === null || raw === undefined || raw === '') continue;
    const v = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (q && !v.toLowerCase().includes(q.toLowerCase())) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return { values: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([value, count]) => ({ value, count })) };
}
