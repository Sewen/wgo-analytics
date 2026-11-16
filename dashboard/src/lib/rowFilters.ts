import type { AnalyticsEvent, ClickRow, ErrorGroup, Filter, HttpErrorGroup, LogRecord, Span, TraceSummary } from '../api/contract';

/**
 * Conditions that describe "rows like this one", offered when you filter or create a trigger from a table row.
 * `checked` ones are preselected: what identifies the row's kind (the service and message of a log, the route and
 * status of a failing request); the rest are there to narrow it down.
 */
export interface RowCondition { filter: Filter; checked: boolean }

const eq = (field: string, value: unknown, checked = false): RowCondition[] =>
  value === null || value === undefined || value === '' ? [] : [{ filter: { field, op: 'eq', value: String(value) }, checked }];

/** Scalar JSON entries as conditions on `prefix.key` (short values only: long ones make poor filters). */
function jsonConditions(obj: Record<string, unknown> | null | undefined, prefix: string, max: number, skip: string[] = []): RowCondition[] {
  return Object.entries(obj ?? {})
    .filter(([k, v]) => !skip.includes(k) && v !== null && v !== '' && ['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 120)
    .slice(0, max)
    .map(([k, v]) => ({ filter: { field: `${prefix}.${k}`, op: 'eq', value: String(v) }, checked: false }));
}

/** Nested event props flattened like the attribute table does (props.props.plan). */
function propConditions(props: Record<string, unknown>, max: number): RowCondition[] {
  const out: RowCondition[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= max) return;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, depth + 1);
    else if (v !== null && v !== '' && ['string', 'number', 'boolean'].includes(typeof v) && String(v).length <= 120) out.push({ filter: { field: path, op: 'eq', value: String(v) }, checked: false });
  };
  walk(props, 'props', 0);
  return out;
}

/**
 * The part of a log message before anything that looks like it varies (numbers, ids, quoted or bracketed
 * values), so "Payment declined for order 42" matches every declined payment. Null when that leaves too little.
 */
export function stablePrefix(body: string): string | null {
  const line = body.split('\n')[0];
  const m = /^[^\d"'`{[(<=#@]*/.exec(line);
  const p = (m?.[0] ?? '').replace(/[\s:,;\-–—/]+$/, '');
  return p.length >= 8 && p.length < line.length ? p.slice(0, 120) : null;
}

const SEV_MIN = [21, 17, 13, 9, 5, 1];

export function logConditions(l: LogRecord): RowCondition[] {
  const sev = SEV_MIN.find((m) => l.severityNumber >= m);
  const prefix = stablePrefix(l.body);
  const body: RowCondition[] = prefix
    ? [{ filter: { field: 'body', op: 'starts_with', value: prefix }, checked: true }, { filter: { field: 'body', op: 'eq', value: l.body.slice(0, 500) }, checked: false }]
    : [{ filter: { field: 'body', op: l.body.length > 500 ? 'starts_with' : 'eq', value: l.body.slice(0, 500) }, checked: true }];
  return [
    ...eq('service', l.service, true),
    ...(sev ? [{ filter: { field: 'severityNumber', op: 'gte' as const, value: String(sev) }, checked: sev >= 13 }] : []),
    ...body,
    ...jsonConditions(l.attributes, 'attributes', 8),
    ...jsonConditions(l.resource, 'resource', 4, ['service.name']),
  ];
}

/** Durations as a round threshold just below the value: 1840 ms → "≥ 1500". */
function slowerThan(ms: number): RowCondition[] {
  if (!(ms > 0)) return [];
  const mag = 10 ** Math.floor(Math.log10(ms));
  const step = ms / mag >= 5 ? mag : mag / 2;
  return [{ filter: { field: 'durationMs', op: 'gte', value: String(Math.max(1, Math.floor(ms / step) * step)) }, checked: false }];
}

export function spanConditions(s: Span): RowCondition[] {
  return [
    ...eq('service', s.service, true),
    ...eq('name', s.name, true),
    ...(s.statusCode === 2 ? eq('statusCode', 2, true) : []),
    ...slowerThan(s.durationMs),
    ...jsonConditions(s.attributes, 'attributes', 8),
  ];
}

export function traceConditions(t: TraceSummary): RowCondition[] {
  return [...eq('service', t.service, true), ...eq('name', t.rootName, true), ...(t.errorCount ? eq('statusCode', 2, true) : []), ...slowerThan(t.durationMs)];
}

/** Conditions that describe "events like this one" (the preselected ones also name the trigger well). */
export function eventConditions(e: AnalyticsEvent): RowCondition[] {
  const key: RowCondition[] = [...eq('type', e.type, true)];
  if (e.type === 'click') key.push(...(e.trackName ? eq('trackName', e.trackName, true) : eq('selector', e.selector, true)));
  else if (e.type === 'error') key.push(...eq('fingerprint', e.fingerprint, true), ...eq('errorMessage', e.errorMessage));
  else if (e.type === 'http_error') key.push(...eq('httpMethod', e.httpMethod), ...eq('httpRoute', e.httpRoute, true), ...eq('httpStatus', e.httpStatus, true));
  else if (e.type === 'custom') key.push(...eq('name', e.name, true));
  else if (e.type === 'pageview') key.push(...eq('path', e.path, true));
  const rest = [
    ...(e.type !== 'pageview' ? eq('path', e.path) : []),
    ...eq('browser', e.browser), ...eq('os', e.os), ...eq('device', e.device), ...eq('country', e.country), ...eq('userId', e.userId),
    ...propConditions(e.props, 6),
  ];
  const seen = new Set(key.map((c) => c.filter.field));
  return [...key, ...rest.filter((c) => !seen.has(c.filter.field))];
}

export const errorGroupConditions = (g: ErrorGroup): RowCondition[] => [
  ...eq('type', 'error', true), ...eq('fingerprint', g.fingerprint, true), ...eq('errorMessage', g.message), ...eq('errorSource', g.source),
];

export const httpGroupConditions = (g: HttpErrorGroup): RowCondition[] => [
  ...eq('type', 'http_error', true), ...eq('httpMethod', g.method, true), ...eq('httpRoute', g.route, true), ...eq('httpStatus', g.status, true),
];

export const clickConditions = (r: ClickRow): RowCondition[] => [
  ...eq('type', 'click', true),
  ...(r.trackName ? eq('trackName', r.trackName, true) : eq('selector', r.selector, true)),
  ...(r.trackName ? eq('selector', r.selector) : []),
  ...eq('elementText', r.elementText),
];
