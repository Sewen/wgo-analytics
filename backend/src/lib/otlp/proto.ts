/**
 * Minimal protobuf decoder for the OTLP export requests (traces, logs, metrics).
 * Produces the same object shape as OTLP/JSON (camelCase field names, hex trace/span ids,
 * 64-bit integers as decimal strings), so one normalizer handles both encodings.
 */

type Scalar = 'string' | 'bytes' | 'hexbytes' | 'varint' | 'bool' | 'int64' | 'uint64' | 'fixed64' | 'sfixed64' | 'double' | 'fixed32' | 'sint32';
type FieldDef = [name: string, type: Scalar | Schema, repeated?: boolean];
interface Schema {
  [field: number]: FieldDef;
}

// ---- schemas (field numbers from opentelemetry-proto v1) ----
const AnyValue: Schema = {};
const KeyValue: Schema = { 1: ['key', 'string'], 2: ['value', AnyValue] };
const ArrayValue: Schema = { 1: ['values', AnyValue, true] };
const KeyValueList: Schema = { 1: ['values', KeyValue, true] };
Object.assign(AnyValue, {
  1: ['stringValue', 'string'],
  2: ['boolValue', 'bool'],
  3: ['intValue', 'int64'],
  4: ['doubleValue', 'double'],
  5: ['arrayValue', ArrayValue],
  6: ['kvlistValue', KeyValueList],
  7: ['bytesValue', 'bytes'],
} satisfies Schema);

const Resource: Schema = { 1: ['attributes', KeyValue, true], 2: ['droppedAttributesCount', 'varint'] };
const Scope: Schema = { 1: ['name', 'string'], 2: ['version', 'string'], 3: ['attributes', KeyValue, true] };

const SpanEvent: Schema = { 1: ['timeUnixNano', 'fixed64'], 2: ['name', 'string'], 3: ['attributes', KeyValue, true] };
const Status: Schema = { 2: ['message', 'string'], 3: ['code', 'varint'] };
const Span: Schema = {
  1: ['traceId', 'hexbytes'],
  2: ['spanId', 'hexbytes'],
  3: ['traceState', 'string'],
  4: ['parentSpanId', 'hexbytes'],
  5: ['name', 'string'],
  6: ['kind', 'varint'],
  7: ['startTimeUnixNano', 'fixed64'],
  8: ['endTimeUnixNano', 'fixed64'],
  9: ['attributes', KeyValue, true],
  11: ['events', SpanEvent, true],
  15: ['status', Status],
};
const ScopeSpans: Schema = { 1: ['scope', Scope], 2: ['spans', Span, true] };
const ResourceSpans: Schema = { 1: ['resource', Resource], 2: ['scopeSpans', ScopeSpans, true] };
export const ExportTraceServiceRequest: Schema = { 1: ['resourceSpans', ResourceSpans, true] };

const LogRecord: Schema = {
  1: ['timeUnixNano', 'fixed64'],
  2: ['severityNumber', 'varint'],
  3: ['severityText', 'string'],
  5: ['body', AnyValue],
  6: ['attributes', KeyValue, true],
  9: ['traceId', 'hexbytes'],
  10: ['spanId', 'hexbytes'],
  11: ['observedTimeUnixNano', 'fixed64'],
  12: ['eventName', 'string'],
};
const ScopeLogs: Schema = { 1: ['scope', Scope], 2: ['logRecords', LogRecord, true] };
const ResourceLogs: Schema = { 1: ['resource', Resource], 2: ['scopeLogs', ScopeLogs, true] };
export const ExportLogsServiceRequest: Schema = { 1: ['resourceLogs', ResourceLogs, true] };

const NumberDataPoint: Schema = {
  7: ['attributes', KeyValue, true],
  2: ['startTimeUnixNano', 'fixed64'],
  3: ['timeUnixNano', 'fixed64'],
  4: ['asDouble', 'double'],
  6: ['asInt', 'sfixed64'],
};
const HistogramDataPoint: Schema = {
  9: ['attributes', KeyValue, true],
  2: ['startTimeUnixNano', 'fixed64'],
  3: ['timeUnixNano', 'fixed64'],
  4: ['count', 'fixed64'],
  5: ['sum', 'double'],
  6: ['bucketCounts', 'fixed64', true],
  7: ['explicitBounds', 'double', true],
  11: ['min', 'double'],
  12: ['max', 'double'],
};
const ExponentialHistogramDataPoint: Schema = {
  1: ['attributes', KeyValue, true],
  2: ['startTimeUnixNano', 'fixed64'],
  3: ['timeUnixNano', 'fixed64'],
  4: ['count', 'fixed64'],
  5: ['sum', 'double'],
  6: ['scale', 'sint32'],
  7: ['zeroCount', 'fixed64'],
  12: ['min', 'double'],
  13: ['max', 'double'],
};
const ValueAtQuantile: Schema = { 1: ['quantile', 'double'], 2: ['value', 'double'] };
const SummaryDataPoint: Schema = {
  7: ['attributes', KeyValue, true],
  2: ['startTimeUnixNano', 'fixed64'],
  3: ['timeUnixNano', 'fixed64'],
  4: ['count', 'fixed64'],
  5: ['sum', 'double'],
  6: ['quantileValues', ValueAtQuantile, true],
};
const Metric: Schema = {
  1: ['name', 'string'],
  2: ['description', 'string'],
  3: ['unit', 'string'],
  5: ['gauge', { 1: ['dataPoints', NumberDataPoint, true] }],
  7: ['sum', { 1: ['dataPoints', NumberDataPoint, true], 2: ['aggregationTemporality', 'varint'], 3: ['isMonotonic', 'bool'] }],
  9: ['histogram', { 1: ['dataPoints', HistogramDataPoint, true], 2: ['aggregationTemporality', 'varint'] }],
  10: ['exponentialHistogram', { 1: ['dataPoints', ExponentialHistogramDataPoint, true], 2: ['aggregationTemporality', 'varint'] }],
  11: ['summary', { 1: ['dataPoints', SummaryDataPoint, true] }],
};
const ScopeMetrics: Schema = { 1: ['scope', Scope], 2: ['metrics', Metric, true] };
const ResourceMetrics: Schema = { 1: ['resource', Resource], 2: ['scopeMetrics', ScopeMetrics, true] };
export const ExportMetricsServiceRequest: Schema = { 1: ['resourceMetrics', ResourceMetrics, true] };

// ---- wire decoding ----
class Reader {
  pos = 0;
  constructor(
    readonly buf: Buffer,
    readonly end = buf.length,
  ) {}

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.end) throw new Error('protobuf: truncated varint');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('protobuf: varint too long');
    }
  }
  bytes(): Buffer {
    const len = Number(this.varint());
    if (this.pos + len > this.end) throw new Error('protobuf: truncated bytes');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  fixed64(): bigint {
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.bytes();
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`protobuf: unsupported wire type ${wireType}`);
  }
}

function readScalar(r: Reader, type: Scalar, wireType: number): unknown {
  switch (type) {
    case 'string':
      return r.bytes().toString('utf8');
    case 'bytes':
      return r.bytes().toString('base64');
    case 'hexbytes':
      return r.bytes().toString('hex');
    case 'bool':
      return r.varint() !== 0n;
    case 'varint':
      return Number(BigInt.asIntN(32, r.varint()));
    case 'sint32': {
      const n = r.varint();
      return Number((n >> 1n) ^ -(n & 1n));
    }
    case 'int64':
      return BigInt.asIntN(64, r.varint()).toString();
    case 'uint64':
      return r.varint().toString();
    case 'fixed64':
      return wireType === 0 ? r.varint().toString() : r.fixed64().toString();
    case 'sfixed64':
      return BigInt.asIntN(64, r.fixed64()).toString();
    case 'double': {
      const v = r.buf.readDoubleLE(r.pos);
      r.pos += 8;
      return v;
    }
    case 'fixed32': {
      const v = r.buf.readUInt32LE(r.pos);
      r.pos += 4;
      return v;
    }
  }
}

const PACKABLE = new Set<Scalar>(['varint', 'bool', 'int64', 'uint64', 'fixed64', 'sfixed64', 'double', 'fixed32', 'sint32']);

function decodeMessage(r: Reader, schema: Schema, depth: number): Record<string, unknown> {
  if (depth > 64) throw new Error('protobuf: nesting too deep');
  const out: Record<string, unknown> = {};
  while (r.pos < r.end) {
    const tag = Number(r.varint());
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    const def = schema[fieldNo];
    if (!def) {
      r.skip(wireType);
      continue;
    }
    const [name, type, repeated] = def;
    if (typeof type === 'object') {
      const sub = r.bytes();
      const value = decodeMessage(new Reader(sub), type, depth + 1);
      if (repeated) ((out[name] ??= []) as unknown[]).push(value);
      else out[name] = value;
    } else if (repeated && wireType === 2 && PACKABLE.has(type)) {
      const data = r.bytes();
      const sub = new Reader(data);
      const arr = (out[name] ??= []) as unknown[];
      const elemWire = type === 'double' || type === 'fixed64' || type === 'sfixed64' ? 1 : type === 'fixed32' ? 5 : 0;
      while (sub.pos < sub.end) arr.push(readScalar(sub, type, elemWire));
    } else {
      const value = readScalar(r, type, wireType);
      if (repeated) ((out[name] ??= []) as unknown[]).push(value);
      else out[name] = value;
    }
  }
  return out;
}

export function decodeProtobuf(buf: Buffer, schema: Schema): Record<string, unknown> {
  return decodeMessage(new Reader(buf), schema, 0);
}
