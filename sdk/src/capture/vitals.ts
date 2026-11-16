import type { Hooks, VitalsData } from '../types'
import { on } from '../util'

const r = Math.round

/** Emits one `vitals` event per page load, the first time the page is hidden. Must be started before the client's own hide/flush listeners so the event is queued before the beacon flush. */
export function startVitals(h: Hooks): () => void {
  const v: VitalsData = {}
  let cls = 0, cur = 0, first = 0, lastT = 0, inp = 0, sent = false
  const obs: PerformanceObserver[] = []
  const supported = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver.supportedEntryTypes || [] : []

  const watch = (type: string, cb: (e: any) => void, extra?: object) => {
    if (typeof PerformanceObserver === 'undefined') return
    try {
      const o = new PerformanceObserver((l) => { try { l.getEntries().forEach(cb) } catch { /* ignore */ } })
      o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit)
      obs.push(o)
    } catch { /* entry type unsupported */ }
  }
  watch('paint', (e) => { if (e.name === 'first-contentful-paint') v.fcp = r(e.startTime) })
  watch('largest-contentful-paint', (e) => { v.lcp = r(e.startTime) })
  watch('layout-shift', (e) => {
    if (e.hadRecentInput) return
    // session window: gap < 1s, max 5s long; CLS is the worst window
    if (cur && e.startTime - lastT < 1000 && e.startTime - first < 5000) cur += e.value
    else { cur = e.value; first = e.startTime }
    lastT = e.startTime
    cls = Math.max(cls, cur)
  })
  // approximation of INP: slowest interaction event
  watch('event', (e) => { if (e.interactionId || e.name === 'click') inp = Math.max(inp, e.duration) }, { durationThreshold: 40 })

  const send = () => {
    if (sent) return
    sent = true
    try {
      const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined
      if (nav) {
        if (nav.responseStart > 0) v.ttfb = r(nav.responseStart)
        if (nav.loadEventEnd > 0) v.load = r(nav.loadEventEnd)
      }
    } catch { /* ignore */ }
    if (cls > 0 || supported.includes('layout-shift')) v.cls = Math.round(cls * 10000) / 10000
    if (inp) v.inp = r(inp)
    obs.forEach((o) => o.disconnect())
    if (Object.keys(v).length) h.emit('vitals', { ...v })
  }
  const stops = [
    on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') send() }),
    on(window, 'pagehide', send),
  ]
  return () => { sent = true; stops.forEach((s) => s()); obs.forEach((o) => o.disconnect()) }
}
