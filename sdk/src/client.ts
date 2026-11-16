import type { Config, Ctx, EmitOpts, EventType, Hooks, ResolvedConfig, WireEvent } from './types'
import { SDK } from './types'
import { migrateStorage } from './legacy'
import { Session } from './session'
import { Transport } from './transport'
import { startClicks } from './capture/clicks'
import { ErrorReporter } from './capture/errors'
import { startHttp } from './capture/http'
import { startPageviews } from './capture/pageviews'
import { startVitals } from './capture/vitals'
import { on, uuid } from './util'

function resolve(c: Config): ResolvedConfig {
  const a = c.autocapture || {}
  return {
    writeKey: c.writeKey,
    endpoint: c.endpoint.replace(/\/+$/, ''),
    autocapture: { clicks: a.clicks ?? true, errors: a.errors ?? true, http: a.http ?? true, pageviews: a.pageviews ?? true, vitals: a.vitals ?? true },
    flushInterval: c.flushInterval ?? 5000,
    priorityFlushDelay: c.priorityFlushDelay ?? 1000,
    maxBatchSize: c.maxBatchSize ?? 50,
    maxBatchBytes: c.maxBatchBytes ?? 60000,
    maxQueueSize: c.maxQueueSize ?? 1000,
    maxRetries: c.maxRetries ?? 6,
    persist: c.persist ?? true,
    sessionTimeout: c.sessionTimeout ?? 30 * 60 * 1000,
    sampleRate: c.sampleRate ?? 1,
    httpIgnore: c.httpIgnore ?? [],
    captureQueryParams: c.captureQueryParams ?? false,
    compress: c.compress ?? true,
    beforeSend: c.beforeSend,
    respectDoNotTrack: c.respectDoNotTrack ?? false,
    release: c.release,
    environment: c.environment,
    debug: c.debug ?? false,
    priorityClicks: c.priorityClicks ?? [],
  }
}

export class Client {
  private cfg: ResolvedConfig
  private session: Session
  private transport: Transport
  private errors: ErrorReporter
  private ctx: Ctx
  private ingest: string
  private stops: (() => void)[] = []
  private stopped = false

  constructor(config: Config) {
    const cfg = (this.cfg = resolve(config))
    const log = (...a: unknown[]) => { if (cfg.debug) console.debug('[wgo]', ...a) }
    this.ingest = `${cfg.endpoint}/ingest`
    migrateStorage(cfg.writeKey)
    this.session = new Session(cfg.sessionTimeout, cfg.sampleRate)
    this.ctx = { sdk: SDK }
    try {
      Object.assign(this.ctx, { ua: navigator.userAgent, lang: navigator.language, sw: screen.width, sh: screen.height })
      this.ctx.tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (navigator.webdriver) this.ctx.wd = true // automated browser: the backend flags it as a bot
    } catch { /* partial ctx is fine */ }
    if (cfg.release) this.ctx.release = cfg.release
    if (cfg.environment) this.ctx.env = cfg.environment

    this.transport = new Transport({
      ...cfg,
      url: this.ingest,
      storageKey: `wgo:q:${cfg.writeKey}`,
      meta: () => ({ k: cfg.writeKey, a: this.session.aid, ctx: this.ctx }),
      log,
    })
    const hooks: Hooks = {
      cfg,
      emit: (t, d, o) => this.emit(t, d, o),
      queued: (e) => this.transport.has(e),
      skipUrl: (u) => u.startsWith(this.ingest) || cfg.httpIgnore.some((p) => (typeof p === 'string' ? u.includes(p) : (p.lastIndex = 0, p.test(u)))),
      clean: (u) => this.clean(u),
      log,
    }
    this.errors = new ErrorReporter(hooks)

    this.transport.restore()
    const ac = cfg.autocapture
    const start = (enabled: boolean, fn: () => () => void) => {
      if (!enabled) return
      try { this.stops.push(fn()) } catch (e) { log('capture failed to start', e) }
    }
    start(ac.clicks, () => startClicks(hooks))
    start(ac.errors, () => this.errors.listen())
    start(ac.http, () => startHttp(hooks))
    start(ac.vitals, () => startVitals(hooks)) // before our hide listener below, see vitals.ts
    start(ac.pageviews, () => startPageviews(hooks))

    const hide = () => this.transport.flushBeacon()
    this.stops.push(
      on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') hide() }),
      on(window, 'pagehide', hide),
      on(window, 'online', () => this.transport.online()),
    )
  }

  private clean(u: string): string {
    return this.cfg.captureQueryParams ? u : u.replace(/\?[^#]*/, '')
  }

  emit(t: EventType, d?: object, o: EmitOpts = {}): WireEvent | null {
    try {
      if (this.stopped) return null
      const s = this.session.touch()
      if (!s.sampled) return null
      let e: WireEvent = { id: uuid(), t, ts: Date.now(), s: s.id, url: this.clean(location.href), path: location.pathname }
      if (this.session.uid) e.u = this.session.uid
      if (document.title) e.title = document.title
      if (o.ref) e.ref = o.ref
      if (d) e.d = d as Record<string, unknown>
      if (this.cfg.beforeSend) {
        let r: WireEvent | null = e
        try { r = this.cfg.beforeSend(e) } catch { /* a throwing hook must not lose the event */ }
        if (!r) return null
        e = r
      }
      this.transport.push(e, o.priority || t === 'error' || t === 'http_error')
      return e
    } catch (err) {
      if (this.cfg.debug) console.debug('[wgo] emit failed', err)
      return null
    }
  }

  track(name: string, props?: Record<string, unknown>): void { this.emit('custom', { name, props }) }
  identify(userId: string, traits?: Record<string, unknown>): void {
    this.session.identify(userId)
    this.emit('identify', { traits })
  }
  page(): void { this.emit('pageview', undefined, { ref: document.referrer ? this.clean(document.referrer) : undefined }) }
  captureException(error: unknown, extra?: object): void { try { this.errors.manual(error, extra) } catch { /* ignore */ } }
  setContext(obj: Record<string, unknown>): void { Object.assign(this.ctx, obj, { sdk: SDK }) }
  flush(): Promise<void> { return this.transport.flush() }
  get queued(): number { return this.transport.length }

  stop(): void {
    this.stopped = true
    this.stops.forEach((s) => { try { s() } catch { /* ignore */ } })
    this.stops = []
    this.transport.destroy()
  }
}
