import type { Hooks } from '../types'
import { on } from '../util'

export function startPageviews(h: Hooks): () => void {
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastPS = location.pathname + location.search
  let lastHash = location.hash.startsWith('#/') ? location.hash : ''
  let prevUrl = h.clean(location.href)

  const ref = document.referrer ? h.clean(document.referrer) : undefined
  h.emit('pageview', undefined, { ref })

  const check = () => {
    timer = undefined
    const ps = location.pathname + location.search
    const hash = location.hash.startsWith('#/') ? location.hash : ''
    if (ps === lastPS && (!hash || hash === lastHash)) return // plain #anchors don't count
    lastPS = ps
    lastHash = hash
    const r = prevUrl
    prevUrl = h.clean(location.href)
    h.emit('pageview', undefined, { ref: r })
  }
  // deferred so SPAs get a chance to update document.title first
  const soon = () => { if (active && timer === undefined) timer = setTimeout(check, 0) }

  const stops = [on(window, 'popstate', soon), on(window, 'hashchange', soon)]
  for (const k of ['pushState', 'replaceState'] as const) {
    const orig = history[k]
    const w = function (this: History, ...a: unknown[]) {
      const r = (orig as (...x: unknown[]) => void).apply(this, a)
      soon()
      return r
    }
    history[k] = w as typeof orig
    stops.push(() => { if (history[k] === w) history[k] = orig })
  }
  return () => { active = false; clearTimeout(timer); stops.forEach((s) => s()) }
}
