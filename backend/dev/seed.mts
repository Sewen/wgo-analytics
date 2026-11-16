/**
 * Sends realistic traffic through the real HTTP endpoints of a running WGO API:
 * SDK batches to /ingest and OTLP/JSON to /v1/{traces,logs,metrics}.
 *
 *   npx tsx dev/seed.mts --key wk_… [--url http://localhost:8787] [--hours 24] [--sessions 300]
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    key: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:8787' },
    hours: { type: 'string', default: '24' },
    sessions: { type: 'string', default: '300' },
  },
});
if (!values.key) throw new Error('--key <write key> is required');
const URL_BASE = values.url!.replace(/\/$/, '');
const HOURS = Number(values.hours);
const SESSIONS = Number(values.sessions);
const now = Date.now();

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const chance = (p: number) => Math.random() < p;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
];
// [country, region, city, lat, lon, weight]: what CloudFront would send for visitors in these places
const PLACES: Array<[string, string, string, number, number, number]> = [
  ['US', 'California', 'San Francisco', 37.77, -122.42, 9], ['US', 'New York', 'New York', 40.71, -74.01, 10],
  ['US', 'Texas', 'Austin', 30.27, -97.74, 4], ['US', 'Washington', 'Seattle', 47.61, -122.33, 4],
  ['US', 'Illinois', 'Chicago', 41.88, -87.63, 4], ['CA', 'Ontario', 'Toronto', 43.65, -79.38, 4],
  ['BR', 'São Paulo', 'São Paulo', -23.55, -46.63, 4], ['MX', 'Mexico City', 'Mexico City', 19.43, -99.13, 2],
  ['GB', 'England', 'London', 51.51, -0.13, 9], ['DE', 'Berlin', 'Berlin', 52.52, 13.4, 6],
  ['SE', 'Stockholm County', 'Stockholm', 59.33, 18.07, 6], ['SE', 'Västra Götaland', 'Göteborg', 57.71, 11.97, 3],
  ['FR', 'Île-de-France', 'Paris', 48.86, 2.35, 5], ['NL', 'North Holland', 'Amsterdam', 52.37, 4.9, 4],
  ['ES', 'Madrid', 'Madrid', 40.42, -3.7, 3], ['PL', 'Mazovia', 'Warsaw', 52.23, 21.01, 2],
  ['IN', 'Karnataka', 'Bengaluru', 12.97, 77.59, 6], ['IN', 'Maharashtra', 'Mumbai', 19.08, 72.88, 3],
  ['JP', 'Tokyo', 'Tokyo', 35.68, 139.69, 5], ['SG', 'Singapore', 'Singapore', 1.35, 103.82, 3],
  ['AU', 'New South Wales', 'Sydney', -33.87, 151.21, 4], ['ZA', 'Gauteng', 'Johannesburg', -26.2, 28.05, 2],
  ['NG', 'Lagos', 'Lagos', 6.52, 3.38, 2], ['KR', 'Seoul', 'Seoul', 37.57, 126.98, 2],
];
const PLACE_WEIGHT = PLACES.reduce((a, p) => a + p[5], 0);
function place() {
  let r = Math.random() * PLACE_WEIGHT;
  for (const p of PLACES) if ((r -= p[5]) <= 0) return p;
  return PLACES[0];
}
const jitter = () => (Math.random() - 0.5) * 0.6; // suburbs around the city

const PAGES = ['/', '/', '/products', '/pricing', '/products/aurora-lamp', '/products/nimbus-chair', '/cart', '/checkout', '/docs/getting-started'];
const REFS = ['https://www.google.com/', 'https://news.ycombinator.com/', 'https://twitter.com/', 'https://www.reddit.com/r/webdev/', undefined, undefined];
const CLICKS = [
  { sel: 'header > button[data-track="signup-cta"].primary', tag: 'button', text: 'Sign up free', name: 'signup-cta' },
  { sel: 'button[data-track="add-to-cart"].add-to-cart', tag: 'button', text: 'Add to cart', name: 'add-to-cart' },
  { sel: '#checkout', tag: 'button', text: 'Checkout', name: 'checkout' },
  { sel: 'nav > a[href="/pricing"]', tag: 'a', text: 'Pricing', href: '/pricing' },
  { sel: 'nav > a[href="/docs"]', tag: 'a', text: 'Read the docs', href: '/docs' },
  { sel: 'footer > form > button.newsletter', tag: 'button', text: 'Subscribe', name: 'newsletter' },
];
const ERRORS = [
  { msg: "TypeError: Cannot read properties of undefined (reading 'price')", stack: 'TypeError: Cannot read properties of undefined\n    at renderCart (https://shop.test/assets/app-3f9a1c.js:1:48211)', kind: 'error' },
  { msg: 'Unhandled rejection: Payment provider timed out', stack: 'Error: Payment provider timed out\n    at pay (https://shop.test/assets/app-3f9a1c.js:1:9921)', kind: 'rejection' },
  { msg: 'ReferenceError: gtag is not defined', stack: 'ReferenceError: gtag is not defined\n    at https://shop.test/assets/vendor-91ac.js:2:113', kind: 'error' },
];
const HTTP_ERRORS = [
  { method: 'GET', url: 'https://api.shop.test/v1/products/{id}/reviews', status: 404 },
  { method: 'POST', url: 'https://api.shop.test/v1/checkout', status: 502 },
  { method: 'GET', url: 'https://api.shop.test/v1/cart', status: 0 },
  { method: 'POST', url: 'https://api.shop.test/v1/orders/{id}/items', status: 422 },
];

/** Diurnal weight so charts have a shape. */
const weight = (t: number) => 0.35 + 0.65 * Math.max(0, Math.sin(((new Date(t).getUTCHours() - 6) / 24) * 2 * Math.PI));
function sessionStart(): number {
  for (;;) {
    const t = now - Math.random() * HOURS * 3600_000;
    if (Math.random() < weight(t)) return t;
  }
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(URL_BASE + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain', ...headers } });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
}

// ---------- product analytics via /ingest ----------
let sent = 0;
for (let i = 0; i < SESSIONS; i++) {
  const sid = randomUUID().slice(0, 12);
  const aid = randomUUID();
  let t = sessionStart();
  const events: unknown[] = [];
  const ev = (type: string, path: string, d?: object, extra: object = {}) =>
    events.push({ id: randomUUID(), t: type, ts: Math.round(t), s: sid, url: `https://shop.test${path}`, path, title: `Shop — ${path}`, d, ...extra });
  let path = pick(PAGES);
  ev('pageview', path, undefined, { ref: pick(REFS) });
  const steps = 1 + Math.floor(Math.random() * 8);
  for (let s = 0; s < steps; s++) {
    t += 2000 + Math.random() * 40_000;
    const c = pick(CLICKS);
    ev('click', path, { ...c, x: 200, y: 300, vw: 1440, vh: 900, ...(chance(0.03) ? { rage: 3 + Math.floor(Math.random() * 3) } : {}) });
    if (chance(0.5)) {
      path = c.href ?? pick(PAGES);
      ev('pageview', path, undefined, { ref: `https://shop.test${path}` });
    }
    if (chance(0.06)) ev('error', path, pick(ERRORS));
    if (chance(0.08)) {
      const h = pick(HTTP_ERRORS);
      ev('http_error', path, { ...h, url: h.url.replace('{id}', String(1000 + Math.floor(Math.random() * 9000))), dur: Math.round(50 + Math.random() * 900), kind: 'fetch' });
    }
    if (chance(0.1)) ev('custom', path, { name: pick(['checkout_started', 'newsletter_subscribed', 'coupon_applied']), props: { value: Math.round(Math.random() * 300) } });
  }
  ev('vitals', path, { lcp: 900 + Math.random() * 3000, fcp: 400 + Math.random() * 1800, cls: Math.random() * 0.3, inp: 60 + Math.random() * 400, ttfb: 80 + Math.random() * 900 });
  const [country, region, city, lat, lon] = place();
  const geo: Record<string, string> = chance(0.95) // a few visitors can't be located
    ? {
        'cloudfront-viewer-country': country,
        'cloudfront-viewer-country-region-name': encodeURIComponent(region),
        'cloudfront-viewer-city': encodeURIComponent(city),
        'cloudfront-viewer-latitude': String(lat + jitter()),
        'cloudfront-viewer-longitude': String(lon + jitter()),
      }
    : {};
  await post('/ingest', { k: values.key, a: aid, sentAt: Date.now(), ctx: { sdk: 'wgo-js/0.1.0', ua: pick(UAS), lang: 'en-US' }, e: events }, geo);
  sent += events.length;
}
console.log(`ingested ${sent} SDK events across ${SESSIONS} sessions`);

// ---------- OpenTelemetry via OTLP/JSON ----------
const attr = (o: Record<string, string | number | boolean>) =>
  Object.entries(o).map(([key, v]) => ({
    key,
    value: typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v },
  }));
const ns = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();
const resource = (service: string) => ({ attributes: attr({ 'service.name': service, 'service.version': '1.4.2', 'deployment.environment': 'production' }) });

type SpanSpec = { service: string; name: string; kind: number; offset: number; dur: number; error?: string; children?: SpanSpec[]; attrs?: Record<string, string | number> };
const ROUTES: Array<() => SpanSpec> = [
  () => ({ service: 'api-gateway', name: 'POST /api/checkout', kind: 2, offset: 0, dur: 0, attrs: { 'http.route': '/api/checkout', 'http.request.method': 'POST' }, children: [
    { service: 'auth-service', name: 'verify_token', kind: 2, offset: 2, dur: 8 + Math.random() * 10 },
    { service: 'cart-service', name: 'lock_cart', kind: 2, offset: 20, dur: 20 + Math.random() * 30, children: [{ service: 'cart-service', name: 'UPDATE carts', kind: 3, offset: 4, dur: 5 + Math.random() * 15, attrs: { 'db.system': 'postgresql' } }] },
    { service: 'payment-service', name: 'charge_card', kind: 2, offset: 70, dur: 150 + Math.random() * 500, error: chance(0.12) ? 'card declined' : undefined, children: [{ service: 'payment-service', name: 'POST api.stripe.com/v1/charges', kind: 3, offset: 5, dur: 120 + Math.random() * 400 }] },
  ] }),
  () => ({ service: 'api-gateway', name: 'GET /api/products', kind: 2, offset: 0, dur: 0, attrs: { 'http.route': '/api/products', 'http.request.method': 'GET' }, children: [
    { service: 'catalog-service', name: 'SELECT products', kind: 3, offset: 3, dur: 5 + Math.random() * 60, attrs: { 'db.system': 'postgresql' } },
  ] }),
  () => ({ service: 'api-gateway', name: 'GET /api/cart', kind: 2, offset: 0, dur: 0, error: chance(0.05) ? 'upstream timeout' : undefined, children: [
    { service: 'cart-service', name: 'redis GET cart', kind: 3, offset: 1, dur: 1 + Math.random() * 4 },
  ] }),
];

const spansBy = new Map<string, unknown[]>();
const logsBy = new Map<string, unknown[]>();
function emitSpan(spec: SpanSpec, traceId: string, parent: string | undefined, start: number): number {
  const spanId = hex(8);
  let end = start + spec.dur;
  for (const c of spec.children ?? []) end = Math.max(end, emitSpan(c, traceId, spanId, start + c.offset) + 2);
  const span = {
    traceId, spanId, parentSpanId: parent, name: spec.name, kind: spec.kind,
    startTimeUnixNano: ns(start), endTimeUnixNano: ns(end), attributes: attr(spec.attrs ?? {}),
    status: spec.error ? { code: 2, message: spec.error } : { code: 0 },
    events: spec.error ? [{ timeUnixNano: ns(end - 1), name: 'exception', attributes: attr({ 'exception.message': spec.error }) }] : [],
  };
  if (!spansBy.has(spec.service)) spansBy.set(spec.service, []);
  spansBy.get(spec.service)!.push(span);
  if (spec.error || chance(0.15)) {
    if (!logsBy.has(spec.service)) logsBy.set(spec.service, []);
    logsBy.get(spec.service)!.push({
      timeUnixNano: ns(end), traceId, spanId,
      severityNumber: spec.error ? 17 : pick([5, 9, 9, 13]), severityText: spec.error ? 'ERROR' : undefined,
      body: { stringValue: spec.error ? `${spec.name} failed: ${spec.error}` : `${spec.name} completed in ${Math.round(end - start)}ms` },
      attributes: attr({ 'code.function': spec.name }),
    });
  }
  return end;
}
const TRACE_HOURS = Math.min(HOURS, 6);
for (let i = 0; i < 400; i++) emitSpan(pick(ROUTES)(), hex(16), undefined, now - Math.random() * TRACE_HOURS * 3600_000);

const headers = { 'content-type': 'application/json', 'x-wgo-key': values.key };
let spans = 0;
for (const [service, list] of spansBy) {
  for (let i = 0; i < list.length; i += 400) {
    await post('/v1/traces', { resourceSpans: [{ resource: resource(service), scopeSpans: [{ scope: { name: 'seed' }, spans: list.slice(i, i + 400) }] }] }, headers);
  }
  spans += list.length;
}
let logs = 0;
for (const [service, list] of logsBy) {
  await post('/v1/logs', { resourceLogs: [{ resource: resource(service), scopeLogs: [{ scope: { name: 'seed' }, logRecords: list }] }] }, headers);
  logs += list.length;
}

const points = (fn: (t: number) => number, attrs: Record<string, string> = {}) =>
  Array.from({ length: TRACE_HOURS * 60 }, (_, m) => {
    const t = now - m * 60_000;
    return { timeUnixNano: ns(t), asDouble: fn(t), attributes: attr(attrs) };
  });
await post('/v1/metrics', {
  resourceMetrics: [{
    resource: resource('api-gateway'),
    scopeMetrics: [{ scope: { name: 'seed' }, metrics: [
      { name: 'http.server.active_requests', unit: '{request}', gauge: { dataPoints: points((t) => Math.round(20 + 30 * weight(t) + Math.random() * 10)) } },
      { name: 'process.memory.usage', unit: 'By', gauge: { dataPoints: [...points(() => 180e6 + Math.random() * 40e6, { instance: 'gw-1' }), ...points(() => 210e6 + Math.random() * 40e6, { instance: 'gw-2' })] } },
      { name: 'http.server.request.duration', unit: 'ms', description: 'Duration of HTTP server requests', histogram: { aggregationTemporality: 1, dataPoints: points((t) => 0).map((p) => {
        const count = 50 + Math.floor(Math.random() * 100);
        return { ...p, asDouble: undefined, count: String(count), sum: count * (40 + Math.random() * 120) };
      }) } },
    ] }],
  }],
}, headers);
console.log(`ingested ${spans} spans, ${logs} logs and 3 metrics via OTLP`);
