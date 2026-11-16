import type { ErrorData, Hooks, WireEvent } from '../types'
import { on } from '../util'

const STACK_MAX = 4000
const COALESCE_MS = 5000
const PER_MINUTE = 30

const isErr = (x: unknown): x is Error => !!x && typeof (x as Error).message === 'string'

export class ErrorReporter {
  private last?: { key: string; ev: WireEvent; at: number }
  private stamps: number[] = []

  constructor(private h: Hooks) {}

  report(d: ErrorData): void {
    const now = Date.now()
    d.msg = String(d.msg).slice(0, 1000)
    if (d.stack) d.stack = d.stack.slice(0, STACK_MAX)
    const key = `${d.msg}|${d.src ?? ''}|${d.line ?? ''}`
    const l = this.last
    if (l && l.key === key && now - l.at < COALESCE_MS && this.h.queued(l.ev) && l.ev.d) {
      const ld = l.ev.d as unknown as ErrorData
      ld.count = (ld.count ?? 1) + 1
      l.at = now
      return
    }
    this.stamps = this.stamps.filter((t) => now - t < 60000)
    if (this.stamps.length >= PER_MINUTE) return
    this.stamps.push(now)
    const ev = this.h.emit('error', d, { priority: true })
    if (ev) this.last = { key, ev, at: now }
  }

  manual(error: unknown, extra?: object): void {
    const e = isErr(error) ? error : null
    const d: ErrorData = { msg: e ? e.message : String(error), kind: 'manual' }
    if (e?.stack) d.stack = e.stack
    if (extra) d.extra = extra
    this.report(d)
  }

  listen(): () => void {
    const clean = this.h.clean
    const stopErr = on(window, 'error', (ev: ErrorEvent) => {
      const t = ev.target as (Element & { src?: unknown; href?: unknown }) | Window | null
      if (t && t !== (window as unknown) && (t as Element).nodeType === 1) {
        const el = t as Element & { src?: unknown; href?: unknown }
        const src = typeof el.src === 'string' && el.src ? el.src : typeof el.href === 'string' ? el.href : ''
        if (src) this.report({ msg: `Failed to load <${el.tagName.toLowerCase()}>`, src: clean(src), kind: 'resource' })
        return
      }
      const err = ev.error
      this.report({
        msg: ev.message || (err != null ? String(err) : 'Unknown error'),
        stack: isErr(err) ? err.stack : undefined,
        src: ev.filename ? clean(ev.filename) : undefined,
        line: ev.lineno || undefined,
        col: ev.colno || undefined,
        kind: 'error',
      })
    }, true)
    const stopRej = on(window, 'unhandledrejection', (ev: PromiseRejectionEvent) => {
      const r = ev.reason
      this.report({ msg: isErr(r) ? r.message : String(r), stack: isErr(r) ? r.stack : undefined, kind: 'rejection' })
    })
    return () => { stopErr(); stopRej() }
  }
}
