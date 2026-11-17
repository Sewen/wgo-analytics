import type { Hooks, HttpErrorData } from '../types'
import { absUrl } from '../util'

interface Info { method: string; url: string; start: number }

/** The Authorization value in fetch headers: a Headers object, [name, value] pairs or a plain record. */
function authOf(hd: unknown): unknown {
  if (!hd) return undefined
  if (typeof (hd as Headers).get === 'function') return (hd as Headers).get('authorization')
  if (Array.isArray(hd)) return hd.find((p) => String(p[0]).toLowerCase() === 'authorization')?.[1]
  for (const k in hd as Record<string, unknown>) if (k.toLowerCase() === 'authorization') return (hd as Record<string, unknown>)[k]
  return undefined
}

/**
 * Wraps fetch and XHR. `errors` reports failed requests (autocapture.http); `h.onAuth` sees the Authorization
 * header of outgoing requests (autoIdentify). Either can run without the other.
 */
export function startHttp(h: Hooks, errors = true): () => void {
  let active = true
  const restores: (() => void)[] = []
  const auth = (v: unknown) => { try { if (active && v) h.onAuth?.(String(v)) } catch { /* ignore */ } }

  const report = (i: Info, status: number, statusText: string | undefined, kind: 'fetch' | 'xhr') => {
    if (!errors) return
    try {
      const d: HttpErrorData = { method: i.method, url: h.clean(i.url), status, dur: Date.now() - i.start, kind }
      if (statusText) d.statusText = statusText
      h.emit('http_error', d, { priority: true })
    } catch { /* never throw into the host */ }
  }

  const g = globalThis as typeof globalThis & { fetch?: typeof fetch }
  const origFetch = g.fetch
  if (typeof origFetch === 'function') {
    const wrapped = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const p = origFetch.apply(this as typeof globalThis, args)
      if (!active) return p
      let info: Info | undefined
      try {
        const [input, init] = args
        const r = input as Partial<Request> & Partial<URL>
        if (h.onAuth) auth(authOf(init?.headers) ?? authOf(r.headers))
        const url = absUrl(typeof input === 'string' ? input : r.url ?? r.href ?? String(input))
        if (!h.skipUrl(url)) info = { url, start: Date.now(), method: String(init?.method || r.method || 'GET').toUpperCase() }
      } catch { /* describe failed: just pass through */ }
      if (info) {
        const i = info
        // derived promise only observes; the caller still gets the original promise and its rejection
        p.then(
          (res) => { if (res.status >= 400) report(i, res.status, res.statusText, 'fetch') },
          (err) => { if (!(err && err.name === 'AbortError') && !args[1]?.signal?.aborted) report(i, 0, undefined, 'fetch') },
        )
      }
      return p
    }
    g.fetch = wrapped as typeof fetch
    restores.push(() => { if (g.fetch === wrapped) g.fetch = origFetch })
  }

  const X = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest
  if (X && X.prototype) {
    const proto = X.prototype
    const origOpen = proto.open
    const origSend = proto.send
    const origSet = proto.setRequestHeader
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>()

    const open = function (this: XMLHttpRequest, method: string, url: string | URL) {
      try { meta.set(this, { method: String(method).toUpperCase(), url: absUrl(String(url)) }) } catch { /* ignore */ }
      return (origOpen as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[])
    }
    const send = function (this: XMLHttpRequest) {
      try {
        const m = active && meta.get(this)
        if (m && !h.skipUrl(m.url)) {
          const info: Info = { ...m, start: Date.now() }
          let aborted = false
          const onAbort = () => { aborted = true }
          this.addEventListener('abort', onAbort)
          this.addEventListener('loadend', () => {
            this.removeEventListener('abort', onAbort)
            if (!aborted && (this.status >= 400 || this.status === 0)) report(info, this.status, this.statusText, 'xhr')
          }, { once: true })
        }
      } catch { /* ignore */ }
      return (origSend as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[])
    }
    const setHeader = function (this: XMLHttpRequest, name: string, value: string) {
      if (h.onAuth && String(name).toLowerCase() === 'authorization') auth(value)
      return origSet.call(this, name, value)
    }
    proto.open = open as typeof proto.open
    proto.send = send as typeof proto.send
    if (h.onAuth) proto.setRequestHeader = setHeader
    restores.push(() => {
      if (proto.open === open) proto.open = origOpen
      if (proto.send === send) proto.send = origSend
      if (proto.setRequestHeader === setHeader) proto.setRequestHeader = origSet
    })
  }

  return () => { active = false; restores.forEach((r) => r()) }
}
