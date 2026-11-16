import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Transport, type TransportOpts } from '../src/transport'
import { SDK } from '../src/types'
import { batchOf, ev, mockFetch, setBeacon } from './helpers'

const URL_ = 'https://api.test/ingest'
function make(over: Partial<TransportOpts> = {}) {
  return new Transport({
    url: URL_, storageKey: 'analytico:q:wk', flushInterval: 5000, priorityFlushDelay: 1000, maxBatchSize: 50,
    maxBatchBytes: 60000, maxQueueSize: 1000, maxRetries: 6, persist: false, compress: false,
    meta: () => ({ k: 'wk', a: 'anon', ctx: { sdk: SDK } }), log: () => {}, ...over,
  })
}
const E = (i: number | string, extra?: Record<string, unknown>) => ev('e' + i, extra) as never

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  setBeacon(undefined)
})

describe('flush deadlines', () => {
  it('flushes flushInterval after the OLDEST event; later events do not postpone it', async () => {
    const f = mockFetch()
    const t = make()
    t.push(E(0))
    for (let i = 1; i <= 4; i++) { await vi.advanceTimersByTimeAsync(1000); t.push(E(i)) }
    expect(f).not.toHaveBeenCalled() // 4000ms
    await vi.advanceTimersByTimeAsync(999)
    expect(f).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f).toHaveBeenCalledTimes(1)
    expect(batchOf(f.mock.calls[0]).e).toHaveLength(5)
  })

  it('a priority event pulls the deadline in to priorityFlushDelay', async () => {
    const f = mockFetch()
    const t = make()
    t.push(E(0))
    await vi.advanceTimersByTimeAsync(2000)
    t.push(E(1), true)
    await vi.advanceTimersByTimeAsync(999)
    expect(f).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f).toHaveBeenCalledTimes(1)
    expect(batchOf(f.mock.calls[0]).e.map((e) => e.id)).toEqual(['e0', 'e1'])
  })

  it('never pushes an earlier deadline later', async () => {
    const f = mockFetch()
    const t = make()
    t.push(E(0), true)
    await vi.advanceTimersByTimeAsync(500)
    t.push(E(1)) // normal event must not move the 1000ms deadline to +5000
    t.push(E(2), true) // nor a second priority one
    await vi.advanceTimersByTimeAsync(500)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('flushes when the count reaches maxBatchSize and never exceeds it per batch', async () => {
    const f = mockFetch()
    const t = make({ maxBatchSize: 10 })
    for (let i = 0; i < 25; i++) t.push(E(i))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.mock.calls.map((c) => batchOf(c).e.length)).toEqual([10, 10, 5])
  })

  it('flushes at ~80% of maxBatchBytes and batches stay under the byte limit', async () => {
    const f = mockFetch()
    const t = make({ maxBatchBytes: 5000 })
    const pad = 'x'.repeat(400)
    for (let i = 0; i < 8; i++) t.push(E(i, { title: pad }))
    expect(f).not.toHaveBeenCalled()
    for (let i = 8; i < 12; i++) t.push(E(i, { title: pad })) // ~4.9KB queued >= 4000
    await vi.advanceTimersByTimeAsync(0)
    expect(f).toHaveBeenCalled()
    for (const c of f.mock.calls) expect(String((c[1] as RequestInit).body).length).toBeLessThanOrEqual(5000)
    expect(f.mock.calls.flatMap((c) => batchOf(c).e)).toHaveLength(12)
  })

  it('drops the oldest events beyond maxQueueSize', async () => {
    const f = mockFetch()
    const t = make({ maxQueueSize: 3, maxBatchSize: 100 })
    for (let i = 0; i < 5; i++) t.push(E(i))
    await t.flush()
    expect(batchOf(f.mock.calls[0]).e.map((e) => e.id)).toEqual(['e2', 'e3', 'e4'])
  })
})

describe('sending', () => {
  it('posts text/plain with keepalive', async () => {
    const f = mockFetch()
    const t = make()
    t.push(E(0))
    await t.flush()
    const init = f.mock.calls[0][1] as RequestInit
    expect(f.mock.calls[0][0]).toBe(URL_)
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain;charset=UTF-8')
  })

  it('gzips payloads over 1KB when compress is on, but not small ones', async () => {
    const f = mockFetch()
    const t = make({ compress: true })
    t.push(E(0))
    await t.flush()
    expect(typeof (f.mock.calls[0][1] as RequestInit).body).toBe('string')
    for (let i = 0; i < 20; i++) t.push(E(i, { title: 'hello world '.repeat(10) }))
    await t.flush()
    const init = f.mock.calls[1][1] as RequestInit
    const body = init.body as Uint8Array
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream')
    expect([body[0], body[1]]).toEqual([0x1f, 0x8b])
  })

  it('keeps a single request in flight', async () => {
    let release!: () => void
    const f = mockFetch(() => new Promise((r) => { release = () => r({ ok: true, status: 200 }) }))
    const t = make({ maxBatchSize: 2 })
    t.push(E(0)); t.push(E(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(f).toHaveBeenCalledTimes(1)
    t.push(E(2)); t.push(E(3))
    await vi.advanceTimersByTimeAsync(10000)
    void t.flush()
    expect(f).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(f).toHaveBeenCalledTimes(2)
    expect(batchOf(f.mock.calls[1]).e.map((e) => e.id)).toEqual(['e2', 'e3'])
  })
})

describe('retry', () => {
  it('retries a 500 with exponential backoff, same batch, then succeeds', async () => {
    let n = 0
    const f = mockFetch(() => (++n <= 3 ? { ok: false, status: 500 } : { ok: true, status: 200 }))
    const t = make()
    t.push(E(0))
    await t.flush()
    expect(f).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999); expect(f).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(f).toHaveBeenCalledTimes(2) // +1s
    await vi.advanceTimersByTimeAsync(1999); expect(f).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); expect(f).toHaveBeenCalledTimes(3) // +2s
    await vi.advanceTimersByTimeAsync(4000); expect(f).toHaveBeenCalledTimes(4) // +4s
    await vi.advanceTimersByTimeAsync(60000); expect(f).toHaveBeenCalledTimes(4)
    expect(f.mock.calls.map((c) => batchOf(c).e[0].id)).toEqual(['e0', 'e0', 'e0', 'e0'])
  })

  it('retries on network errors and on 429', async () => {
    let n = 0
    const f = mockFetch(() => { n++; if (n === 1) throw new TypeError('Failed to fetch'); return n === 2 ? { ok: false, status: 429 } : { ok: true, status: 200 } })
    const t = make()
    t.push(E(0))
    await t.flush()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('puts the failed batch back at the front of the queue, ahead of newer events', async () => {
    let n = 0
    const f = mockFetch(() => (++n === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 }))
    const t = make()
    t.push(E(0))
    await t.flush()
    t.push(E(1))
    await vi.advanceTimersByTimeAsync(1000)
    expect(batchOf(f.mock.calls[1]).e.map((e) => e.id)).toEqual(['e0', 'e1'])
  })

  it('caps backoff at 60s and drops the batch after maxRetries', async () => {
    const f = mockFetch(() => ({ ok: false, status: 500 }))
    const t = make({ maxRetries: 8 })
    t.push(E(0))
    await t.flush()
    const times: number[] = []
    let last = Date.now()
    f.mockImplementation(async () => { times.push(Date.now() - last); last = Date.now(); return { ok: false, status: 500 } })
    await vi.advanceTimersByTimeAsync(10 * 60000)
    expect(f).toHaveBeenCalledTimes(9) // 1 + 8 retries
    expect(times).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
    expect(t.length).toBe(0)
  })

  it('drops on other 4xx without retrying', async () => {
    const f = mockFetch(() => ({ ok: false, status: 400 }))
    const t = make()
    t.push(E(0))
    await t.flush()
    await vi.advanceTimersByTimeAsync(120000)
    expect(f).toHaveBeenCalledTimes(1)
    expect(t.length).toBe(0)
  })

  it('does not send while offline and flushes on online', async () => {
    const f = mockFetch()
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    const t = make()
    t.push(E(0))
    await vi.advanceTimersByTimeAsync(10000)
    expect(f).not.toHaveBeenCalled()
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    t.online()
    await vi.advanceTimersByTimeAsync(0)
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('beacon', () => {
  it('sends everything via sendBeacon as text/plain Blob, in chunks under 60KB', async () => {
    const f = mockFetch()
    const beacon = vi.fn(() => true)
    setBeacon(beacon)
    const t = make({ maxBatchBytes: 100000, maxBatchSize: 1000, compress: true })
    const pad = 'y'.repeat(1000)
    for (let i = 0; i < 150; i++) t.push(E(i, { title: pad }))
    t.flushBeacon()
    expect(f).not.toHaveBeenCalled()
    expect(beacon.mock.calls.length).toBeGreaterThanOrEqual(3)
    let total = 0
    for (const c of beacon.mock.calls as unknown as [string, Blob][]) {
      expect(c[0]).toBe(URL_)
      expect(c[1].type).toBe('text/plain')
      expect(c[1].size).toBeLessThan(60000)
      total += JSON.parse(await c[1].text()).e.length
    }
    expect(total).toBe(150)
    expect(t.length).toBe(0)
  })

  it('falls back to keepalive fetch when sendBeacon is missing or refuses', () => {
    const f = mockFetch()
    setBeacon(() => false)
    const t = make()
    t.push(E(0))
    t.flushBeacon()
    expect(f).toHaveBeenCalledTimes(1)
    expect((f.mock.calls[0][1] as RequestInit).keepalive).toBe(true)
  })
})

describe('persistence', () => {
  const key = 'analytico:q:wk'
  it('mirrors the queue to localStorage at most once per second and syncs on persistNow', async () => {
    mockFetch()
    const t = make({ persist: true })
    const set = vi.spyOn(Storage.prototype, 'setItem')
    t.push(E(0)); t.push(E(1)); t.push(E(2))
    expect(set).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(set).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(3)
    t.push(E(3))
    t.persistNow()
    expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(4)
  })

  it('removes the key once the queue is sent', async () => {
    mockFetch()
    const t = make({ persist: true })
    t.push(E(0))
    t.persistNow()
    await t.flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('restores and sends a persisted queue, capped at maxQueueSize', async () => {
    const f = mockFetch()
    localStorage.setItem(key, JSON.stringify([1, 2, 3, 4, 5].map((i) => ev('old' + i))))
    const t = make({ persist: true, maxQueueSize: 4 })
    t.restore()
    await vi.advanceTimersByTimeAsync(0)
    expect(batchOf(f.mock.calls[0]).e.map((e) => e.id)).toEqual(['old2', 'old3', 'old4', 'old5'])
  })

  it('ignores corrupt data and survives storage that throws', () => {
    localStorage.setItem(key, '{nope')
    const t = make({ persist: true })
    expect(() => t.restore()).not.toThrow()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => { t.push(E(0)); t.persistNow(); t.restore() }).not.toThrow()
  })
})
