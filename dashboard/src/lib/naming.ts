import type { Filter, FilterScope } from '../api/contract';
import { fieldLabel, OP_LABEL } from './filters';

/**
 * Readable names for filtered views and triggers, generated from their filters:
 *   [{type = error}, {path = /checkout}, {browser = Chrome}]          → "Errors on /checkout in Chrome"
 *   logs [{severityNumber ≥ 17}, {service = api}, {body contains x}]  → "Error logs from api containing “x”"
 * Well-known fields read as words; anything else is appended as "field = value".
 */

const EVENT_NOUN: Record<string, string> = {
  pageview: 'Pageviews', click: 'Clicks', error: 'Errors', http_error: 'Failed requests', custom: 'Custom events',
  vitals: 'Web vitals', identify: 'Identify calls',
};
const SEVERITY: Array<[number, string]> = [[21, 'Fatal'], [17, 'Error'], [13, 'Warning'], [9, 'Info'], [5, 'Debug'], [1, 'Trace']];
export const severityName = (n: number) => SEVERITY.find(([min]) => n >= min)?.[1] ?? 'Trace';
const SCOPE_NOUN: Record<FilterScope, string> = { events: 'Events', logs: 'Logs', spans: 'Spans' };
/** What a page shows, for naming its saved views. */
const PAGE_NOUN: Record<string, string> = {
  overview: 'Overview', clicks: 'Clicks', errors: 'Errors', network: 'Failed requests', events: 'Events', logs: 'Logs', traces: 'Traces',
};

const clip = (v: string, n = 32) => (v.length > n ? v.slice(0, n - 1) + '…' : v);
const q = (v: string, n = 32) => `“${clip(v, n)}”`;
const short = (v: string) => (v.length > 12 ? v.slice(0, 8) : v);
const ms = (v: string) => (Number(v) >= 1000 ? `${+(Number(v) / 1000).toFixed(2)} s` : `${v} ms`);

/** Short label for a field in a name: OTel/JSON paths without their column prefix. */
function nameLabel(field: string): string {
  const m = /^(?:attributes|resource|props)\.(.+)$/.exec(field);
  if (!m) return fieldLabel(field);
  return field.startsWith('props.props.') ? field.slice(12) : m[1];
}

/** Generic phrasing, used for fields without a special reading. */
function generic({ field, op, value = '' }: Filter): string {
  const l = nameLabel(field);
  switch (op) {
    case 'eq': return `${l} = ${clip(value)}`;
    case 'neq': return `${l} ≠ ${clip(value)}`;
    case 'set': return `with ${l}`;
    case 'not_set': return `without ${l}`;
    case 'contains': case 'not_contains': case 'starts_with': case 'ends_with': return `${l} ${OP_LABEL[op]} ${q(value)}`;
    default: return `${l} ${OP_LABEL[op]} ${value}`;
  }
}

type Part = { noun?: string; nounIfDefault?: string; before?: string; lead?: string; phrase?: string; generic?: string };
const SPAN_KIND = ['Unspecified', 'Internal', 'Server', 'Client', 'Producer', 'Consumer'];

function read(scope: FilterScope, f: Filter): Part {
  const v = f.value ?? '';
  const { field, op } = f;
  const eq = op === 'eq';
  if (scope === 'events') {
    if (field === 'type' && eq && EVENT_NOUN[v]) return { noun: EVENT_NOUN[v] };
    if (field === 'name' && eq) return { noun: `${q(v)} events` };
    if ((field === 'trackName' || field === 'elementText') && eq) return { nounIfDefault: 'Clicks', phrase: `on ${q(v)}` };
    if (field === 'selector' && eq) return { nounIfDefault: 'Clicks', phrase: `on ${clip(v, 40)}` };
    if (field === 'path' || field === 'url') {
      if (eq) return { phrase: `on ${clip(v, 40)}` };
      if (op === 'starts_with') return { phrase: `under ${clip(v, 40)}` };
    }
    if (field === 'httpRoute' && eq) return { phrase: `to ${clip(v, 40)}` };
    if (field === 'httpMethod' && eq) return { before: v.toUpperCase() };
    if (field === 'httpStatus') {
      if (eq) return { phrase: `with status ${v === '0' ? 'network error' : v}` };
      if (op === 'gte' || op === 'gt') return { phrase: `with status ${op === 'gte' ? '≥' : '>'} ${v}` };
    }
    if (field === 'errorMessage' && (eq || op === 'contains')) return { nounIfDefault: 'Errors', phrase: q(v, 40) };
    if (field === 'fingerprint' && eq) return { nounIfDefault: 'Errors', phrase: `in group ${short(v)}` };
    if ((field === 'browser' || field === 'os') && eq) return { phrase: `${field === 'os' ? 'on' : 'in'} ${v}` };
    if (field === 'device' && eq) return { phrase: `on ${v}` };
    if ((field === 'country' || field === 'city' || field === 'region') && eq) return { phrase: `from ${v}` };
    if (field === 'referrer' && (eq || op === 'contains')) return { phrase: `referred by ${clip(v)}` };
    if (field === 'referrer' && op === 'not_set') return { phrase: 'with no referrer' };
    if (field === 'userId' && eq) return { phrase: `by ${clip(v)}` };
    if (field === 'sessionId' && eq) return { phrase: `in session ${short(v)}` };
    if (field === 'anonId' && eq) return { phrase: `by visitor ${short(v)}` };
  }
  if (scope === 'logs') {
    if (field === 'severityNumber' && (op === 'gte' || eq) && /^\d+$/.test(v)) {
      const n = Number(v), s = severityName(n);
      return { noun: op === 'gte' && n < 17 ? `${s}+ logs` : `${s} logs` };
    }
    if (field === 'severityText' && eq) return { noun: `${v.charAt(0).toUpperCase()}${v.slice(1).toLowerCase()} logs` };
    if (field === 'service' && eq) return { phrase: `from ${v}` };
    if (field === 'body') {
      if (op === 'contains') return { phrase: `containing ${q(v)}` };
      if (op === 'starts_with') return { phrase: `starting ${q(v)}` };
      if (eq) return { phrase: q(v, 40) };
      if (op === 'not_contains') return { phrase: `not containing ${q(v)}` };
    }
    if (field === 'traceId' && eq) return { phrase: `in trace ${short(v)}` };
  }
  if (scope === 'spans') {
    if (field === 'statusCode' && eq && v === '2') return { noun: 'Failing spans' };
    if (field === 'service' && eq) return { phrase: `in ${v}` };
    if (field === 'name' && eq) return { lead: `named ${q(v, 40)}` };
    if (field === 'kind' && eq && SPAN_KIND[Number(v)]) return { noun: `${SPAN_KIND[Number(v)]} spans` };
    if (field === 'name' && op === 'contains') return { phrase: `matching ${q(v)}` };
    if (field === 'traceId' && eq) return { phrase: `in trace ${short(v)}` };
  }
  if (field === 'durationMs' && /^\d+(\.\d+)?$/.test(v)) {
    if (op === 'gte' || op === 'gt') return { phrase: `slower than ${ms(v)}` };
    if (op === 'lte' || op === 'lt') return { phrase: `faster than ${ms(v)}` };
  }
  return { generic: generic(f) };
}

/**
 * Name for a set of filters. `base` is what the rows are called without filters (defaults to the scope's
 * noun); a filter like "type = error" replaces it.
 */
export function suggestName(scope: FilterScope, filters: Filter[], base?: string): string {
  const fallback = base ?? SCOPE_NOUN[scope];
  let noun = fallback;
  const before: string[] = [], leads: string[] = [], phrases: string[] = [], generics: string[] = [];
  const pending: string[] = [];
  for (const f of filters) {
    const p = read(scope, f);
    if (p.noun) noun = p.noun;
    if (p.nounIfDefault) pending.push(p.nounIfDefault);
    if (p.before) before.push(p.before);
    if (p.lead) leads.push(p.lead);
    if (p.phrase) phrases.push(p.phrase);
    if (p.generic) generics.push(p.generic);
  }
  if (noun === fallback && pending.length && (base === undefined || base === 'Events')) noun = pending[0];
  if (base === 'Traces') noun = noun.replace(/\bspans$/, 'traces'); // the traces page lists traces
  phrases.unshift(...leads);
  const head = [...before, before.length ? noun.charAt(0).toLowerCase() + noun.slice(1) : noun].join(' ');
  const sep = phrases.length ? ', ' : generics[0]?.startsWith('with') ? ' ' : ' with ';
  const name = [head, ...phrases].join(' ') + (generics.length ? sep + generics.join(', ') : '');
  return name.length > 80 ? name.slice(0, 79) + '…' : name;
}

/** Name for a saved view of a page: its page options and filters, in words. */
export const suggestViewName = (page: string, scope: FilterScope, filters: Filter[]) => suggestName(scope, filters, PAGE_NOUN[page] ?? SCOPE_NOUN[scope]);
