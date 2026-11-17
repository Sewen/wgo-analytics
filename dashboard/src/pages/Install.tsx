import { useState } from 'react';
import { getConfig } from '../api/config';
import type { Project } from '../api/contract';
import { CodeBlock } from '../ui/CodeBlock';
import { Segmented } from '../ui/kit';
import { DEFAULT_OPTIONS, scriptSnippet, SnippetOptionsPanel } from './SnippetOptions';

export function Install({ project }: { project: Project }) {
  const cfg = getConfig();
  const key = project.writeKey;
  const [tab, setTab] = useState<'script' | 'track' | 'otel'>('script');
  const [proto, setProto] = useState<'http/protobuf' | 'http/json'>('http/protobuf');
  const [opts, setOpts] = useState(DEFAULT_OPTIONS);

  const script = scriptSnippet(opts, cfg.sdkUrl, key, cfg.ingestUrl);
  const remembered = opts.cookieless ? 'Cookieless: call it on every page load.' : "It's remembered on this browser until reset().";
  const identifyScript = `<script>
  // When a user logs in. ${remembered}
  WGO.identify(user.email);

  // When they log out
  WGO.reset();
</script>`;
  const track = `<!-- Name a click: it shows up as a track name in Clicks -->
<button data-track="signup-cta">Start free trial</button>

<!-- Never record clicks on this element -->
<button data-wgo-ignore>Internal debug</button>

<!-- Record the click but mask the element text -->
<button data-wgo-mask>jane@example.com</button>

<script>
  // Custom events from code
  WGO.track('checkout_completed', { plan: 'pro', value: 49 });
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
      <Segmented value={tab} onChange={setTab} options={[{ value: 'script', label: 'Script tag' }, { value: 'track', label: 'Tracking clicks' }, { value: 'otel', label: 'OpenTelemetry' }]} />
      {tab === 'script' && (<div className="space-y-2"><p className="text-[12.5px] text-muted">Paste before <code className="font-mono">&lt;/head&gt;</code>. Clicks, pageviews, errors, failed requests and web vitals are captured automatically.</p><CodeBlock code={script} lang="html" title="index.html" /></div>)}
      {tab === 'script' && (
        <>
          <div className="space-y-3 border-t border-line pt-4">
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="text-[13px] font-semibold">Options</h4>
              {opts !== DEFAULT_OPTIONS && <button className="text-[12px] text-muted hover:text-fg cursor-pointer" onClick={() => setOpts(DEFAULT_OPTIONS)}>Reset to defaults</button>}
            </div>
            <p className="text-[12.5px] text-muted">The snippet above updates as you change these.</p>
            <SnippetOptionsPanel value={opts} onChange={setOpts} />
          </div>
          <div className="space-y-2 border-t border-line pt-4">
            <h4 className="text-[13px] font-semibold">Identify users from your code</h4>
            <p className="text-[12.5px] text-muted">Pass your own user id, such as an email or an internal id, when someone logs in. Their earlier anonymous events on that browser count as theirs too.</p>
            <CodeBlock code={identifyScript} lang="html" title="page.html" />
          </div>
        </>
      )}
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
