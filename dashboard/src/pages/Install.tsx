import { useState } from 'react';
import { getConfig } from '../api/config';
import type { Project } from '../api/contract';
import { CodeBlock } from '../ui/CodeBlock';
import { Segmented } from '../ui/kit';

export function Install({ project }: { project: Project }) {
  const cfg = getConfig();
  const key = project.writeKey;
  const [tab, setTab] = useState<'script' | 'npm' | 'track' | 'otel'>('script');
  const [proto, setProto] = useState<'http/protobuf' | 'http/json'>('http/protobuf');

  const script = `<script src="${cfg.sdkUrl}" data-write-key="${key}" data-endpoint="${cfg.ingestUrl}" async></script>`;
  const npmFmt = `import { init } from 'wgo-sdk';

init({
  writeKey: '${key}',
  endpoint: '${cfg.ingestUrl}',
});`;
  const track = `<!-- Name a click: it shows up as a track name in Clicks -->
<button data-track="signup-cta">Start free trial</button>

<!-- Never record clicks on this element -->
<button data-wgo-ignore>Internal debug</button>

<!-- Record the click but mask the element text -->
<button data-wgo-mask>jane@example.com</button>

<script>
  // Custom events from code
  WGO.track('checkout_completed', { plan: 'pro', value: 49 });

  // Who is logged in. Their events from before the login count as theirs too.
  // Or add data-auto-identify to the script tag to read the email from your app's JWT.
  WGO.identify('jane@example.com');
  // On logout
  WGO.reset();
</script>`;
  const env = `OTEL_EXPORTER_OTLP_ENDPOINT=${cfg.ingestUrl}
OTEL_EXPORTER_OTLP_HEADERS=x-wgo-key=${key}
OTEL_EXPORTER_OTLP_PROTOCOL=${proto}
OTEL_SERVICE_NAME=my-service`;
  const exporterPkg = proto === 'http/json' ? '@opentelemetry/exporter-trace-otlp-http' : '@opentelemetry/exporter-trace-otlp-proto';
  const node = `// npm i @opentelemetry/sdk-node ${exporterPkg}
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '${exporterPkg}';

const sdk = new NodeSDK({
  serviceName: 'my-service',
  traceExporter: new OTLPTraceExporter({
    url: '${cfg.ingestUrl}/v1/traces',
    headers: { 'x-wgo-key': '${key}' },
  }),
});
sdk.start();`;
  const py = `# pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider(resource=Resource.create({"service.name": "my-service"}))
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
    endpoint="${cfg.ingestUrl}/v1/traces",
    headers={"x-wgo-key": "${key}"},
)))
trace.set_tracer_provider(provider)`;

  return (
    <div className="space-y-4">
      <Segmented value={tab} onChange={setTab} options={[{ value: 'script', label: 'Script tag' }, { value: 'npm', label: 'npm' }, { value: 'track', label: 'Tracking clicks' }, { value: 'otel', label: 'OpenTelemetry' }]} />
      {tab === 'script' && (<div className="space-y-2"><p className="text-[12.5px] text-muted">Paste before <code className="font-mono">&lt;/head&gt;</code>. Clicks, pageviews, errors, failed requests and web vitals are captured automatically.</p><CodeBlock code={script} lang="html" title="index.html" /></div>)}
      {tab === 'npm' && (<div className="space-y-3"><p className="text-[12.5px] text-muted">The package isn't on npm yet. Build it from <code className="font-mono">sdk/</code> in the WGO repo and install it locally.</p><CodeBlock code="npm i ./path/to/wgo/sdk" lang="sh" title="terminal" /><CodeBlock code={npmFmt} lang="js" title="main.ts" /></div>)}
      {tab === 'track' && (<div className="space-y-2"><p className="text-[12.5px] text-muted">Add attributes to steer what gets recorded, or send custom events yourself.</p><CodeBlock code={track} lang="html" title="page.html" /></div>)}
      {tab === 'otel' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3"><span className="text-[12.5px] text-muted">Protocol</span><Segmented value={proto} onChange={setProto} options={[{ value: 'http/protobuf', label: 'http/protobuf' }, { value: 'http/json', label: 'http/json' }]} /></div>
          <CodeBlock code={env} lang="sh" title="environment" />
          <p className="text-[12.5px] text-muted">For complete Node.js and Python examples, including AWS Lambda, see the <a href="#/docs/opentelemetry" target="_blank" rel="noreferrer" className="text-accent hover:underline">OpenTelemetry setup guide</a>.</p>
          <CodeBlock code={node} lang="js" title="Node.js" />
          <CodeBlock code={py} lang="py" title="Python" />
        </div>
      )}
    </div>
  );
}
