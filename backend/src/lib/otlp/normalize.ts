import { randomUUID } from 'node:crypto';

/** Works on OTLP/JSON-shaped objects (also produced by proto.ts from protobuf). */

type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number | string;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
  bytesValue?: string;
};
type KeyValue = { key: string; value?: AnyValue };
type Attrs = KeyValue[] | undefined;

export function anyValue(v: AnyValue | undefined): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : String(v.intValue);
  }
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValue);
  if (v.kvlistValue) return attrs(v.kvlistValue.values);
  if (v.bytesValue !== undefined) return v.bytesValue;
  return null;
}

export function attrs(list: Attrs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list ?? []) if (kv?.key) out[kv.key] = anyValue(kv.value);
  return out;
}

/** Unix nanos (string|number) -> Date. Falls back to `fallback` for zero/missing values. */
export function nanosToDate(n: string | number | undefined, fallback?: Date): Date {
  if (n === undefined || n === null || n === '' || n === '0' || n === 0) return fallback ?? new Date();
  const big = BigInt(typeof n === 'number' ? Math.round(n) : n);
  return new Date(Number(big / 1_000_000n) + Number(big % 1_000_000n) / 1e6);
}

function nanosDiffMs(start: string | number | undefined, end: string | number | undefined): number {
  if (!start || !end) return 0;
  const d = BigInt(end) - BigInt(start);
  return d < 0n ? 0 : Number(d) / 1e6;
}

/** OTLP/JSON ids are hex, but some exporters send base64 (proto3 JSON mapping); normalize to lowercase hex. */
export function normalizeId(id: string | undefined): string | null {
  if (!id) return null;
  if (/^[0-9a-f]+$/i.test(id) && (id.length === 32 || id.length === 16)) return /^0+$/.test(id) ? null : id.toLowerCase();
  try {
    const hex = Buffer.from(id, 'base64').toString('hex');
    return hex && !/^0+$/.test(hex) ? hex : null;
  } catch {
    return null;
  }
}

const SPAN_KINDS: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0, SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2, SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5,
};
const STATUS_CODES: Record<string, number> = { STATUS_CODE_UNSET: 0, STATUS_CODE_OK: 1, STATUS_CODE_ERROR: 2 };
const enumNum = (v: unknown, map: Record<string, number>) => (typeof v === 'number' ? v : typeof v === 'string' ? (map[v] ?? Number(v)) || 0 : 0);

const serviceOf = (res: Record<string, unknown>) => String(res['service.name'] ?? 'unknown_service');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

// ---------- traces ----------
export interface SpanRow {
  project_id: string;
  start_time: Date;
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  kind: number;
  service: string;
  end_time: Date;
  duration_ms: number;
  status_code: number;
  status_message: string | null;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  events: Array<{ name: string; ts: string; attributes: Record<string, unknown> }>;
}
export const SPAN_COLUMNS: (keyof SpanRow)[] = [
  'project_id', 'start_time', 'span_id', 'trace_id', 'parent_span_id', 'name', 'kind', 'service', 'end_time',
  'duration_ms', 'status_code', 'status_message', 'attributes', 'resource', 'events',
];

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeTraces(projectId: string, req: any): SpanRow[] {
  const rows: SpanRow[] = [];
  for (const rs of req?.resourceSpans ?? []) {
    const resource = attrs(rs.resource?.attributes);
    const service = serviceOf(resource);
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      for (const s of ss.spans ?? []) {
        const traceId = normalizeId(s.traceId);
        const spanId = normalizeId(s.spanId);
        if (!traceId || !spanId) continue;
        const start = nanosToDate(s.startTimeUnixNano);
        rows.push({
          project_id: projectId,
          start_time: start,
          span_id: spanId,
          trace_id: traceId,
          parent_span_id: normalizeId(s.parentSpanId),
          name: clip(String(s.name ?? ''), 512),
          kind: enumNum(s.kind, SPAN_KINDS),
          service,
          end_time: nanosToDate(s.endTimeUnixNano, start),
          duration_ms: nanosDiffMs(s.startTimeUnixNano, s.endTimeUnixNano),
          status_code: enumNum(s.status?.code, STATUS_CODES),
          status_message: s.status?.message || null,
          attributes: attrs(s.attributes),
          resource,
          events: (s.events ?? []).slice(0, 128).map((e: any) => ({
            name: String(e.name ?? ''),
            ts: nanosToDate(e.timeUnixNano, start).toISOString(),
            attributes: attrs(e.attributes),
          })),
        });
      }
    }
  }
  return rows;
}

// ---------- logs ----------
export interface LogRow {
  project_id: string;
  ts: Date;
  id: string;
  severity_number: number;
  severity_text: string | null;
  body: string;
  service: string;
  trace_id: string | null;
  span_id: string | null;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
}
export const LOG_COLUMNS: (keyof LogRow)[] = [
  'project_id', 'ts', 'id', 'severity_number', 'severity_text', 'body', 'service', 'trace_id', 'span_id', 'attributes', 'resource',
];

const SEVERITY_FROM_TEXT: Array<[RegExp, number]> = [
  [/^fatal|^crit|^emerg|^alert/i, 21],
  [/^err/i, 17],
  [/^warn/i, 13],
  [/^info|^notice/i, 9],
  [/^debug/i, 5],
  [/^trace/i, 1],
];

export function normalizeLogs(projectId: string, req: any): LogRow[] {
  const rows: LogRow[] = [];
  const now = new Date();
  for (const rl of req?.resourceLogs ?? []) {
    const resource = attrs(rl.resource?.attributes);
    const service = serviceOf(resource);
    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const bodyVal = anyValue(lr.body);
        let severity = enumNum(lr.severityNumber, {});
        if (!severity && lr.severityText) severity = SEVERITY_FROM_TEXT.find(([re]) => re.test(lr.severityText))?.[1] ?? 0;
        const attributes = attrs(lr.attributes);
        if (lr.eventName) attributes['event.name'] = lr.eventName;
        rows.push({
          project_id: projectId,
          ts: nanosToDate(lr.timeUnixNano, nanosToDate(lr.observedTimeUnixNano, now)),
          id: randomUUID(),
          severity_number: severity,
          severity_text: lr.severityText || null,
          body: clip(typeof bodyVal === 'string' ? bodyVal : JSON.stringify(bodyVal ?? ''), 32_000),
          service,
          trace_id: normalizeId(lr.traceId),
          span_id: normalizeId(lr.spanId),
          attributes,
          resource,
        });
      }
    }
  }
  return rows;
}

// ---------- metrics ----------
export interface MetricRow {
  project_id: string;
  ts: Date;
  id: string;
  name: string;
  type: 'gauge' | 'sum' | 'histogram' | 'exponential_histogram' | 'summary';
  unit: string | null;
  description: string | null;
  service: string;
  value: number;
  count: number | null;
  attributes: Record<string, unknown>;
}
export const METRIC_COLUMNS: (keyof MetricRow)[] = [
  'project_id', 'ts', 'id', 'name', 'type', 'unit', 'description', 'service', 'value', 'count', 'attributes',
];

export function normalizeMetrics(projectId: string, req: any): MetricRow[] {
  const rows: MetricRow[] = [];
  for (const rm of req?.resourceMetrics ?? []) {
    const resource = attrs(rm.resource?.attributes);
    const service = serviceOf(resource);
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        const base = {
          project_id: projectId,
          name: clip(String(m.name ?? ''), 256),
          unit: m.unit || null,
          description: m.description ? clip(String(m.description), 1024) : null,
          service,
        };
        const push = (type: MetricRow['type'], dp: any, value: number, count: number | null) => {
          if (!Number.isFinite(value)) return;
          rows.push({ ...base, type, ts: nanosToDate(dp.timeUnixNano), id: randomUUID(), value, count, attributes: attrs(dp.attributes) });
        };
        const num = (dp: any) => (dp.asDouble !== undefined ? Number(dp.asDouble) : Number(dp.asInt ?? 0));
        for (const dp of m.gauge?.dataPoints ?? []) push('gauge', dp, num(dp), null);
        for (const dp of m.sum?.dataPoints ?? []) push('sum', dp, num(dp), null);
        // Histograms/summaries are stored as their mean so they chart like any other series.
        const mean = (dp: any) => {
          const count = Number(dp.count ?? 0);
          return { count, value: count ? Number(dp.sum ?? 0) / count : 0 };
        };
        for (const dp of m.histogram?.dataPoints ?? []) {
          const { count, value } = mean(dp);
          push('histogram', dp, value, count);
        }
        for (const dp of m.exponentialHistogram?.dataPoints ?? []) {
          const { count, value } = mean(dp);
          push('exponential_histogram', dp, value, count);
        }
        for (const dp of m.summary?.dataPoints ?? []) {
          const { count, value } = mean(dp);
          push('summary', dp, value, count);
        }
      }
    }
  }
  return rows;
}
