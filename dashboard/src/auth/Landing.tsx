import type { ReactNode } from 'react';
import { Bot, Wrench } from 'lucide-react';
import { Logo } from '../ui/Logo';
import { Button } from '../ui/kit';
import { CodeBlock } from '../ui/CodeBlock';
import { navigate } from '../lib/router';
import { cn } from '../lib/format';

/** Screenshots in public/home/, taken from the mock dashboard (npm run dev:mock). Relative so a sub-path deploy works. */
const shot = (file: string) => `home/${file}`;

function Shot({ src, alt, w, h, eager }: { src: string; alt: string; w: number; h: number; eager?: boolean }) {
  return (
    <img src={shot(src)} alt={alt} width={w} height={h} loading={eager ? 'eager' : 'lazy'} decoding="async"
      className="h-auto w-full rounded-xl border border-[var(--line-strong)] shadow-[0_30px_80px_-30px_rgba(0,0,0,.8)]" />
  );
}

function Points({ items, first }: { items: ReactNode[]; first?: boolean }) {
  return (
    <ul className={cn(first ? 'mt-6 lg:mt-0' : 'mt-6', 'space-y-3 text-[14px] leading-relaxed text-muted')}>
      {items.map((t, i) => <li key={i} className="flex gap-3"><span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[var(--faint)]" />{t}</li>)}
    </ul>
  );
}

function Feature({ id, title, intro, points, extra, media, flip, wide }: {
  id: string; title: string; intro: ReactNode; points: ReactNode[]; extra?: ReactNode; media: ReactNode; flip?: boolean;
  /** Text above a full-width screenshot, for dashboard pages that are unreadable at half width. */
  wide?: boolean;
}) {
  const heading = (
    <>
      <h2 className="text-[28px] font-semibold leading-tight tracking-tight">{title}</h2>
      <p className="mt-4 text-[15.5px] leading-relaxed text-muted">{intro}</p>
    </>
  );
  if (wide) {
    return (
      <section id={id} className="py-20">
        <div className="grid gap-x-16 gap-y-2 lg:grid-cols-2">
          <div>{heading}</div>
          <div className="lg:pt-1"><Points items={points} first />{extra && <div className="mt-7">{extra}</div>}</div>
        </div>
        <div className="mt-12">{media}</div>
      </section>
    );
  }
  return (
    <section id={id} className="grid items-center gap-10 py-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
      <div className={cn(flip && 'lg:order-2')}>
        {heading}
        <Points items={points} />
        {extra && <div className="mt-7">{extra}</div>}
      </div>
      <div className={cn('min-w-0', flip && 'lg:order-1')}>{media}</div>
    </section>
  );
}

/** Example MCP conversation. There is no UI to screenshot, so it's drawn here with the real tool names. */
function McpExample() {
  const calls = [['list_errors', 'range: "24h"'], ['list_failed_requests', 'range: "24h"'], ['list_traces', 'service: "payment-service", errors: true']];
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--line-strong)] bg-[var(--raised)] shadow-[0_30px_80px_-30px_rgba(0,0,0,.8)]">
      <div className="border-b border-line px-5 py-3 text-[12.5px] text-faint">Example conversation in an MCP client</div>
      <div className="space-y-5 p-5 text-[14px] leading-relaxed">
        <div className="ml-auto max-w-[85%] rounded-xl bg-[var(--hl)] px-4 py-3">Checkout complaints started this afternoon. What's going on?</div>
        <div className="space-y-1.5 font-mono text-[12px] text-faint">
          {calls.map(([n, a]) => <div key={n} className="flex items-center gap-2"><Wrench size={12} className="shrink-0" /><span className="text-muted">wgo.{n}</span><span className="truncate">{a}</span></div>)}
        </div>
        <div className="flex gap-3">
          <Bot size={18} className="mt-0.5 shrink-0 text-faint" />
          <div className="space-y-3 text-fg/90">
            <p>Failed calls to <code className="font-mono text-[13px]">POST /api/checkout</code> went from a handful an hour to 41 since 14:00, almost all 502s. The matching traces in payment-service spend 8–10 s waiting on the card processor before timing out.</p>
            <p>The browser side follows from that: most new JavaScript errors are a TypeError on /checkout, thrown when the response body is empty.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  const origin = window.location.origin;
  const signIn = () => navigate('/signin');
  const signUp = () => navigate('/signup');
  const ctas = (
    <div className="flex flex-wrap gap-3">
      <Button variant="primary" className="!px-5 !py-2.5 !text-[14px]" onClick={signUp}>Create an account</Button>
      <Button className="!px-5 !py-2.5 !text-[14px]" onClick={signIn}>Sign in</Button>
    </div>
  );

  return (
    <div className="bg-atmos h-full overflow-y-auto">
      <header className="sticky top-0 z-10 border-b border-line bg-[color-mix(in_srgb,var(--bg)_80%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
          <Logo size={28} />
          <nav className="flex items-center gap-1 text-[13.5px]">
            {[['#analytics', 'Web analytics'], ['#otel', 'OpenTelemetry'], ['#android', 'Android'], ['#mcp', 'MCP']].map(([h, t]) => (
              <a key={h} href={h} onClick={(e) => { e.preventDefault(); document.getElementById(h.slice(1))?.scrollIntoView({ behavior: 'smooth' }); }}
                className="hidden rounded-lg px-3 py-1.5 text-muted hover:bg-[var(--hl)] hover:text-fg md:block">{t}</a>
            ))}
            <span className="mx-2 hidden h-5 w-px bg-[var(--line)] md:block" />
            <Button variant="ghost" onClick={signIn}>Sign in</Button>
            <Button variant="primary" onClick={signUp}>Create an account</Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1200px] px-6">
        <section className="pb-8 pt-20 lg:pt-28">
          <div className="max-w-[760px]">
            <h1 className="text-[40px] font-semibold leading-[1.1] tracking-tight sm:text-[52px]">See what's going on in your web app and the services behind it</h1>
            <p className="mt-6 max-w-[620px] text-[17px] leading-relaxed text-muted">
              WGO collects clicks, pageviews, errors and Web Vitals from the browser, and traces, logs and metrics from your backends over
              OpenTelemetry. It all lands in one dashboard that updates as it happens.
            </p>
            <div className="mt-9">{ctas}</div>
          </div>
          <div className="mt-16"><Shot src="overview.jpg" alt="The WGO overview page: pageviews, sessions, users, clicks and errors with sparklines, events over time, Web Vitals and a visitor map" w={2880} h={1800} eager /></div>
        </section>

        <div className="divide-y divide-[var(--line)]">
          <Feature id="analytics" title="Live web analytics" wide
            intro="Add one script tag and WGO records every click, pageview, JavaScript error, failed API call and Web Vital without any extra code. Events show up within seconds."
            points={[
              'Watch a button, page or error and see each hit arrive, with an optional toast or browser notification.',
              'A live map shows where visitors are, to the nearest city. Locations come from CloudFront, and IP addresses are never stored.',
              'The browser SDK is about 9 KB gzipped. It batches and compresses events, and holds on to them while the visitor is offline.',
            ]}
            media={<Shot src="live.jpg" alt="The Live page: click counters for the signup button, add to cart and checkout, and a world map with recent events at each location" w={2416} h={2000} />} />

          <Feature id="otel" title="OpenTelemetry metrics, traces and logs" wide
            intro="Point any OpenTelemetry SDK or Collector at WGO with three environment variables. Your backend telemetry sits next to your web analytics, in the same project."
            points={[
              'Gauges, sums, histograms, exponential histograms and summaries. Chart the average, sum, min, max or p95, and split a series by any attribute.',
              'Each trace opens as a span waterfall. Logs can be filtered by severity, service and text, and link to their trace.',
              'OTLP over HTTP, as protobuf or JSON, gzipped or not.',
            ]}
            extra={<>
              <CodeBlock lang="sh" title="Environment" code={`OTEL_EXPORTER_OTLP_ENDPOINT=${origin}\nOTEL_EXPORTER_OTLP_HEADERS=x-wgo-key=wk_…\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`} />
              <a href="#/docs/opentelemetry" className="mt-4 inline-block text-[14px] font-medium text-accent hover:underline">Setup guide for Node.js and Python, on servers and AWS Lambda</a>
            </>}
            media={<Shot src="metrics.jpg" alt="The Metrics page: a list of OpenTelemetry metrics such as http.server.request.duration, with a chart of the selected metric over 24 hours" w={2416} h={1220} />} />

          <Feature id="android" title="A home-screen widget for Android"
            intro="Keep the numbers you care about on your phone. Pick a project, a time range and up to eight stats: visitors right now, errors, failed API calls, Web Vitals, backend latency, your tracked clicks or any OpenTelemetry metric."
            points={[
              'Resize it from a single number at 2×1 up to a chart with a grid of tiles at 4×3.',
              'Connect the phone by scanning a QR code in the dashboard. It gets a read-only key that you can revoke at any time.',
              'It refreshes in the background every 15 to 180 minutes, or immediately when you tap refresh. You can download the app after signing in.',
            ]}
            media={<div className="mx-auto w-full max-w-[340px]"><img src={shot('widget.png')} alt="The WGO widget on an Android home screen, showing pageviews with a chart and tiles for sessions, JavaScript errors, clicks and failed API calls" width={640} height={1360} loading="lazy" decoding="async" className="h-auto w-full drop-shadow-[0_30px_60px_rgba(0,0,0,.6)]" /></div>} />

          <Feature id="mcp" title="Ask your AI assistant with MCP" flip
            intro="Connect Claude, VS Code or any other MCP client to WGO and ask about traffic, errors, traces and metrics in plain language. The assistant looks up the numbers itself, so you don't have to paste screenshots into the chat."
            points={[
              'You sign in with your WGO account in the browser. There is no API key to copy.',
              'Access is read-only and limited to the projects you are a member of.',
              'Seventeen tools cover the overview, top pages and clicks, conversion goals, errors, failed requests, Web Vitals, visitor locations, traces, logs and metrics.',
            ]}
            extra={<CodeBlock lang="sh" title="Claude Code" code={`claude mcp add --transport http wgo ${origin}/mcp`} />}
            media={<McpExample />} />
        </div>

        <section className="border-t border-line py-24">
          <div className="max-w-[640px]">
            <h2 className="text-[28px] font-semibold leading-tight tracking-tight">Your data stays in your AWS account</h2>
            <p className="mt-4 text-[15.5px] leading-relaxed text-muted">
              WGO is open source and runs on Lambda, Aurora DSQL, DynamoDB and CloudFront in the account it's deployed to. It scales to zero when nobody is using it.
            </p>
            <div className="mt-8">{ctas}</div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-8 text-[12.5px] text-faint">
          <Logo size={22} />
          <span>Open source under the MIT license</span>
        </div>
      </footer>
    </div>
  );
}
