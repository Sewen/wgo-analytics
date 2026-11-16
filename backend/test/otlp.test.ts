import { context, SeverityNumber, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  JsonLogsSerializer, JsonMetricsSerializer, JsonTraceSerializer,
  ProtobufLogsSerializer, ProtobufMetricsSerializer, ProtobufTraceSerializer,
} from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { normalizeLogs, normalizeMetrics, normalizeTraces } from '../src/lib/otlp/normalize';
import { decodeProtobuf, ExportLogsServiceRequest, ExportMetricsServiceRequest, ExportTraceServiceRequest } from '../src/lib/otlp/proto';

const resource = resourceFromAttributes({ 'service.name': 'checkout', 'deployment.environment': 'test' });
const PID = '00000000-0000-4000-8000-000000000001';

/** Encode with the official OTel JS serializers, decode both encodings, and compare. */
function both<T>(json: Uint8Array | undefined, proto: Uint8Array | undefined, schema: Parameters<typeof decodeProtobuf>[1], normalize: (p: string, r: unknown) => T[]) {
  const fromJson = normalize(PID, JSON.parse(Buffer.from(json!).toString('utf8')));
  const fromProto = normalize(PID, decodeProtobuf(Buffer.from(proto!), schema));
  return { fromJson, fromProto };
}

const stripIds = <T extends { id?: string }>(rows: T[]) => rows.map(({ id: _id, ...r }) => r);

describe('OTLP traces', () => {
  it('decodes protobuf identically to JSON and normalizes spans', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    const tracer = provider.getTracer('test');
    tracer.startActiveSpan('GET /checkout', { kind: SpanKind.SERVER, attributes: { 'http.route': '/checkout', 'http.status_code': 500, big: 2 ** 40, ok: true, list: ['a', 'b'] } }, (root) => {
      const child = tracer.startSpan('SELECT orders', { kind: SpanKind.CLIENT, attributes: { 'db.system': 'postgresql', ratio: 0.25 } }, trace.setSpan(context.active(), root));
      child.addEvent('retry', { attempt: 2 });
      child.setStatus({ code: SpanStatusCode.ERROR, message: 'deadlock' });
      child.end();
      root.end();
    });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    const { fromJson, fromProto } = both(
      JsonTraceSerializer.serializeRequest(spans),
      ProtobufTraceSerializer.serializeRequest(spans),
      ExportTraceServiceRequest,
      normalizeTraces,
    );
    expect(fromProto).toEqual(fromJson);
    expect(fromProto).toHaveLength(2);

    const child = fromProto.find((s) => s.name === 'SELECT orders')!;
    const root = fromProto.find((s) => s.name === 'GET /checkout')!;
    expect(root.parent_span_id).toBeNull();
    expect(child.parent_span_id).toBe(root.span_id);
    expect(child.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(child.trace_id).toBe(spans[0].spanContext().traceId);
    expect(child.kind).toBe(3);
    expect(root.kind).toBe(2);
    expect(child.status_code).toBe(2);
    expect(child.status_message).toBe('deadlock');
    expect(child.service).toBe('checkout');
    expect(child.attributes).toEqual({ 'db.system': 'postgresql', ratio: 0.25 });
    expect(root.attributes).toMatchObject({ 'http.status_code': 500, big: 2 ** 40, ok: true, list: ['a', 'b'] });
    expect(child.events[0]).toMatchObject({ name: 'retry', attributes: { attempt: 2 } });
    expect(root.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Math.abs(root.start_time.getTime() - Date.now())).toBeLessThan(10_000);
  });
});

describe('OTLP logs', () => {
  it('decodes protobuf identically to JSON', async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ resource, processors: [new SimpleLogRecordProcessor({ exporter })] });
    const logger = provider.getLogger('test');
    logger.emit({ severityNumber: SeverityNumber.ERROR, severityText: 'ERROR', body: 'payment failed', attributes: { orderId: 42 } });
    logger.emit({ severityNumber: SeverityNumber.INFO, body: { structured: true, n: 1 } });
    await provider.forceFlush();
    const records = exporter.getFinishedLogRecords();

    const { fromJson, fromProto } = both(
      JsonLogsSerializer.serializeRequest(records),
      ProtobufLogsSerializer.serializeRequest(records),
      ExportLogsServiceRequest,
      normalizeLogs,
    );
    expect(stripIds(fromProto)).toEqual(stripIds(fromJson));
    expect(fromProto[0]).toMatchObject({ severity_number: 17, severity_text: 'ERROR', body: 'payment failed', service: 'checkout', attributes: { orderId: 42 } });
    expect(JSON.parse(fromProto[1].body)).toEqual({ structured: true, n: 1 });
  });
});

describe('OTLP metrics', () => {
  it('decodes gauges, sums and histograms from protobuf identically to JSON', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ resource, readers: [reader] });
    const meter = provider.getMeter('test');
    meter.createCounter('orders', { unit: '{order}' }).add(3, { region: 'eu' });
    const h = meter.createHistogram('latency', { unit: 'ms', description: 'request latency' });
    h.record(10);
    h.record(30);
    meter.createObservableGauge('queue.depth').addCallback((r) => r.observe(7.5));
    await reader.forceFlush();
    const metrics = exporter.getMetrics()[0];

    const { fromJson, fromProto } = both(
      JsonMetricsSerializer.serializeRequest(metrics),
      ProtobufMetricsSerializer.serializeRequest(metrics),
      ExportMetricsServiceRequest,
      normalizeMetrics,
    );
    expect(stripIds(fromProto)).toEqual(stripIds(fromJson));
    const byName = Object.fromEntries(fromProto.map((m) => [m.name, m]));
    expect(byName.orders).toMatchObject({ type: 'sum', value: 3, unit: '{order}', attributes: { region: 'eu' } });
    expect(byName.latency).toMatchObject({ type: 'histogram', value: 20, count: 2, description: 'request latency' });
    expect(byName['queue.depth']).toMatchObject({ type: 'gauge', value: 7.5 });
    await provider.shutdown();
  });
});

describe('queued OTLP requests', () => {
  it('reads the signal, write key and content type from the meta attribute API Gateway writes', async () => {
    const { parseQueuedRequest } = await import('../src/handlers/otlp');
    const body = gzipSync(Buffer.from('{"resourceSpans":[]}'));
    const req = parseQueuedRequest(body.toString('base64'), 'signal=traces\ncontent-type=application/x-protobuf\nx-wgo-key=wk_header\nkey=wk_query');
    expect(req).toMatchObject({ signal: 'traces', protobuf: true, writeKey: 'wk_header' });
    expect(req.body().toString('utf8')).toBe('{"resourceSpans":[]}');

    // the query-string key is the fallback; values may contain '='
    expect(parseQueuedRequest('', 'signal=logs\ncontent-type=application/json\nkey=wk_a=b')).toMatchObject({ signal: 'logs', protobuf: false, writeKey: 'wk_a=b' });
    expect(parseQueuedRequest('', 'signal=metrics\nauthorization=Bearer wk_bearer').writeKey).toBe('wk_bearer');
    expect(parseQueuedRequest('', undefined)).toMatchObject({ signal: undefined, writeKey: undefined });
  });

  it('gives log and metric rows ids that are stable per message and position', async () => {
    const { assignStableIds } = await import('../src/lib/otlp/ingest');
    const rows = () => [{ id: 'x' }, { id: 'y' }] as never[];
    const a = rows(); const b = rows(); const c = rows();
    assignStableIds(a, 'msg-1'); assignStableIds(b, 'msg-1'); assignStableIds(c, 'msg-2');
    expect(a).toEqual(b);
    expect(a[0]).not.toEqual(a[1]);
    expect(a[0]).not.toEqual(c[0]);
    for (const r of [...a, ...c] as { id: string }[]) expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
