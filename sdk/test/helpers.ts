import { vi } from 'vitest'
import type { Batch, Config } from '../src/types'

export const NO_AUTO = { clicks: false, errors: false, http: false, pageviews: false, vitals: false }
export const EP = 'https://api.test'
export const INGEST = `${EP}/ingest`

type Handler = (url: string, init: RequestInit) => Promise<Partial<Response>> | Partial<Response>

export function mockFetch(handler: Handler = () => ({ ok: true, status: 200, statusText: 'OK' })) {
  const f = vi.fn(async (input: unknown, init: RequestInit = {}) => handler(String(input), init))
  vi.stubGlobal('fetch', f)
  return f
}

/** Calls made to the ingest endpoint only (excludes app traffic in interceptor tests). */
export const ingestCalls = (f: ReturnType<typeof mockFetch>) => f.mock.calls.filter((c) => String(c[0]) === INGEST)

export const batchOf = (call: unknown[]): Batch => JSON.parse(String((call[1] as RequestInit).body))
export const eventsOf = (f: ReturnType<typeof mockFetch>) => ingestCalls(f).flatMap((c) => batchOf(c).e)

export const cfg = (over: Partial<Config> = {}): Config => ({
  writeKey: 'wk_test',
  endpoint: EP,
  autocapture: NO_AUTO,
  persist: false,
  compress: false,
  ...over,
})

export function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

export const ev = (id: string, extra: Record<string, unknown> = {}) => ({
  id, t: 'custom' as const, ts: 1, s: 's', url: 'http://x/', path: '/', d: { name: id }, ...extra,
})

export function setBeacon(fn: ((url: string, data: Blob) => boolean) | undefined) {
  Object.defineProperty(navigator, 'sendBeacon', { value: fn, configurable: true, writable: true })
}
