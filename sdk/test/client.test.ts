import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '../src/index'
import { Session } from '../src/session'
import { uuid } from '../src/util'
import { INGEST, NO_AUTO, batchOf, cfg, eventsOf, ingestCalls, mockFetch, setBeacon, setHidden } from './helpers'

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  history.replaceState(null, '', '/start')
})
afterEach(() => {
  A.shutdown()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setBeacon(undefined)
  setHidden(false)
})

describe('wire format', () => {
  it('produces the documented batch and event shapes', async () => {
    const f = mockFetch()
    A.init(cfg({ release: '1.2.3', environment: 'prod', autocapture: { ...NO_AUTO, pageviews: true } }))
    A.identify('user-1', { plan: 'pro' })
    A.track('signup', { a: 1 })
    A.setContext({ appVersion: 'x' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(ingestCalls(f)).toHaveLength(1)
    const b = batchOf(ingestCalls(f)[0])
    expect(Object.keys(b).sort()).toEqual(['a', 'ctx', 'e', 'k', 'sentAt'])
    expect(b.k).toBe('wk_test')
    expect(b.a).toBe(localStorage.getItem('wgo:aid'))
    expect(b.sentAt).toBe(Date.now())
    expect(b.ctx).toMatchObject({ sdk: 'wgo-js/0.1.0', release: '1.2.3', env: 'prod', appVersion: 'x' })
    expect(typeof b.ctx.ua).toBe('string')
    expect(b.e.map((e) => e.t)).toEqual(['pageview', 'identify', 'custom'])
    const [pv, idt, cu] = b.e
    for (const e of b.e) {
      expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(e.ts).toBeGreaterThan(1.7e12)
      expect(e.ts).toBeLessThanOrEqual(Date.now())
      expect(e.s).toBe(b.e[0].s)
      expect(e.url).toBe('http://localhost:3000/start')
      expect(e.path).toBe('/start')
    }
    expect(pv.u).toBeUndefined() // before identify()
    expect(idt).toMatchObject({ u: 'user-1', d: { traits: { plan: 'pro' } } })
    expect(cu).toMatchObject({ u: 'user-1', d: { name: 'signup', props: { a: 1 } } })
    expect(localStorage.getItem('wgo:uid')).toBe('user-1')
  })

  it('posts to endpoint/ingest even with a trailing slash', async () => {
    const f = mockFetch()
    A.init(cfg({ endpoint: 'https://api.test///' }))
    A.track('x')
    await A.flush()
    expect(String(f.mock.calls[0][0])).toBe(INGEST)
  })

  it('strips query strings from urls unless captureQueryParams', async () => {
    const f = mockFetch()
    history.replaceState(null, '', '/p?token=secret#frag')
    A.init(cfg())
    A.track('x')
    await A.flush()
    expect(eventsOf(f)[0].url).toBe('http://localhost:3000/p#frag')
    A.shutdown()
    A.init(cfg({ captureQueryParams: true }))
    A.track('y')
    await A.flush()
    expect(eventsOf(f)[1].url).toContain('?token=secret')
  })
})

describe('init', () => {
  it('ignores a second init (the SDK may legitimately be loaded twice) and keeps the first config', async () => {
    const f = mockFetch()
    A.init(cfg())
    A.init(cfg({ writeKey: 'wk_other' }))
    await A.flush()
    expect(f.mock.calls.every((c) => batchOf(c).k !== 'wk_other')).toBe(true)
    expect(A.status().initialized).toBe(true)
  })

  it('does nothing when respectDoNotTrack and DNT is on', async () => {
    const f = mockFetch()
    vi.spyOn(navigator, 'doNotTrack', 'get').mockReturnValue('1')
    A.init(cfg({ respectDoNotTrack: true }))
    A.track('x')
    await A.flush()
    expect(f).not.toHaveBeenCalled()
  })

  it('restores a persisted queue on init and sends it', async () => {
    const f = mockFetch()
    localStorage.setItem('wgo:q:wk_test', JSON.stringify([{ id: 'old', t: 'custom', ts: 1, s: 's', url: 'u', path: '/', d: { name: 'old' } }]))
    A.init(cfg({ persist: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(eventsOf(f).map((e) => e.id)).toEqual(['old'])
  })

  it('sampleRate 0 sends nothing; the decision sticks for the session', async () => {
    const f = mockFetch()
    A.init(cfg({ sampleRate: 0 }))
    A.track('x')
    await A.flush()
    expect(f).not.toHaveBeenCalled()
  })

  it('beforeSend can modify or drop events', async () => {
    const f = mockFetch()
    A.init(cfg({ beforeSend: (e) => (e.d?.name === 'drop' ? null : { ...e, title: 'T' }) }))
    A.track('drop'); A.track('keep')
    await A.flush()
    const es = eventsOf(f)
    expect(es).toHaveLength(1)
    expect(es[0]).toMatchObject({ title: 'T', d: { name: 'keep' } })
  })

  it('shutdown restores history and fetch, removes listeners', async () => {
    const push = history.pushState
    const f = mockFetch()
    const fetchBefore = globalThis.fetch
    A.init(cfg({ autocapture: { clicks: true, errors: true, http: true, pageviews: true, vitals: true } }))
    expect(history.pushState).not.toBe(push)
    expect(globalThis.fetch).not.toBe(fetchBefore)
    A.shutdown()
    expect(history.pushState).toBe(push)
    expect(globalThis.fetch).toBe(fetchBefore)
    document.body.click()
    window.dispatchEvent(new ErrorEvent('error', { message: 'x' }))
    await vi.advanceTimersByTimeAsync(10000)
    expect(f).not.toHaveBeenCalled()
  })

  it('never throws into the host when called before init', async () => {
    expect(() => { A.track('x'); A.identify('u'); A.page(); A.captureException(new Error('e')); A.setContext({}) }).not.toThrow()
    await A.flush()
  })
})

describe('lifecycle flush', () => {
  it('flushes everything by beacon when the page becomes hidden', async () => {
    const f = mockFetch()
    const beacon = vi.fn(() => true)
    setBeacon(beacon)
    A.init(cfg())
    A.track('a'); A.track('b')
    setHidden(true)
    expect(beacon).toHaveBeenCalledTimes(1)
    const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob]
    expect(url).toBe(INGEST)
    expect(blob.type).toBe('text/plain')
    expect(JSON.parse(await blob.text()).e).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10000)
    expect(f).not.toHaveBeenCalled()
  })

  it('flushes on pagehide', () => {
    const beacon = vi.fn(() => true)
    setBeacon(beacon)
    mockFetch()
    A.init(cfg())
    A.track('a')
    window.dispatchEvent(new Event('pagehide'))
    expect(beacon).toHaveBeenCalledTimes(1)
  })

  it('does not beacon while offline; keeps the queue persisted instead', () => {
    const beacon = vi.fn(() => true)
    setBeacon(beacon)
    mockFetch()
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    A.init(cfg({ persist: true }))
    A.track('a')
    window.dispatchEvent(new Event('pagehide'))
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    expect(beacon).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('wgo:q:wk_test')!)).toHaveLength(1)
  })
})

describe('pageviews', () => {
  const on = { ...NO_AUTO, pageviews: true }
  it('emits on init and on SPA navigation, only when path+search change', async () => {
    const f = mockFetch()
    A.init(cfg({ autocapture: on }))
    history.pushState(null, '', '/a')
    history.pushState(null, '', '/a') // same
    await vi.advanceTimersByTimeAsync(0)
    history.replaceState(null, '', '/a?x=1')
    await vi.advanceTimersByTimeAsync(0)
    history.pushState(null, '', '/a?x=1#section') // plain anchor: ignored
    await vi.advanceTimersByTimeAsync(0)
    history.pushState(null, '', '/a?x=1#/route') // route-like hash counts
    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await vi.advanceTimersByTimeAsync(0)
    await A.flush()
    expect(eventsOf(f).map((e) => e.path)).toEqual(['/start', '/a', '/a', '/a'])
    expect(eventsOf(f).every((e) => e.t === 'pageview')).toBe(true)
  })

  it('does not capture anything when pageviews autocapture is off', async () => {
    const f = mockFetch()
    A.init(cfg())
    history.pushState(null, '', '/zzz')
    await vi.advanceTimersByTimeAsync(10000)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('vitals', () => {
  it('emits one vitals event when first hidden, before the beacon flush', async () => {
    mockFetch()
    const beacon = vi.fn(() => true)
    setBeacon(beacon)
    A.init(cfg({ autocapture: { ...NO_AUTO, vitals: true } }))
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ responseStart: 120.4, loadEventEnd: 900.2 }] as never)
    setHidden(true)
    setHidden(false)
    setHidden(true)
    const blobs = beacon.mock.calls.map((c) => (c as unknown as [string, Blob])[1])
    const events = (await Promise.all(blobs.map((b) => b.text()))).flatMap((t) => JSON.parse(t).e)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ t: 'vitals', d: { ttfb: 120, load: 900 } })
  })
})

describe('session', () => {
  it('rotates after the inactivity timeout, not before; activity extends it', () => {
    const s = new Session(30 * 60000, 1)
    const first = s.touch().id
    vi.advanceTimersByTime(20 * 60000)
    expect(s.touch().id).toBe(first)
    vi.advanceTimersByTime(29 * 60000) // 29 min since last activity
    expect(s.touch().id).toBe(first)
    vi.advanceTimersByTime(30 * 60000 + 1)
    expect(s.touch().id).not.toBe(first)
  })

  it('persists session and anonymous ids across instances, rotates stale stored sessions', () => {
    const a = new Session(1000, 1)
    const id = a.touch().id
    const b = new Session(1000, 1)
    expect(b.aid).toBe(a.aid)
    expect(b.touch().id).toBe(id)
    vi.advanceTimersByTime(1001)
    expect(new Session(1000, 1).touch().id).not.toBe(id)
  })

  it('events after the timeout carry a new session id', async () => {
    const f = mockFetch()
    A.init(cfg({ sessionTimeout: 60000 }))
    A.track('a')
    vi.advanceTimersByTime(61000)
    A.track('b')
    await A.flush()
    const [x, y] = eventsOf(f)
    expect(x.s).not.toBe(y.s)
  })

  it('works when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    const s = new Session(1000, 1)
    expect(s.touch().id).toBe(s.touch().id)
  })
})

describe('cookieless', () => {
  it('never reads or writes localStorage, even with persist on; ids still hold within the page', async () => {
    localStorage.setItem('wgo:aid', 'stored-aid')
    localStorage.setItem('wgo:uid', 'stored-uid')
    localStorage.setItem('analytico:aid', 'legacy-aid')
    const snapshot = () => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))
    const before = snapshot()
    const f = mockFetch()
    A.init(cfg({ cookieless: true, persist: true, autocapture: { ...NO_AUTO, pageviews: true } }))
    A.identify('user-1')
    A.track('a')
    await vi.advanceTimersByTimeAsync(5000)
    expect(snapshot()).toEqual(before)
    const b = batchOf(ingestCalls(f)[0])
    expect(b.a).not.toBe('stored-aid')
    const [pv, idt, cu] = b.e
    expect(pv.u).toBeUndefined()
    expect(idt.u).toBe('user-1')
    expect(cu.u).toBe('user-1')
    expect(new Set(b.e.map((e) => e.s)).size).toBe(1)
  })

  it('a new page load starts a new anonymous id and session', async () => {
    const f = mockFetch()
    A.init(cfg({ cookieless: true }))
    A.track('a')
    await A.flush()
    A.shutdown()
    A.init(cfg({ cookieless: true }))
    A.track('b')
    await A.flush()
    const [x, y] = ingestCalls(f).map(batchOf)
    expect(x.a).not.toBe(y.a)
    expect(x.e[0].s).not.toBe(y.e[0].s)
  })
})

describe('uuid', () => {
  it('falls back when crypto.randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', { getRandomValues: (b: Uint8Array) => b.fill(7) })
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
