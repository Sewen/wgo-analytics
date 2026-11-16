import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as A from '../src/index'
import { NO_AUTO, cfg, eventsOf, mockFetch } from './helpers'

const on = { ...NO_AUTO, errors: true }
const fire = (message: string, extra: Partial<ErrorEventInit> = {}) =>
  window.dispatchEvent(new ErrorEvent('error', { message, filename: 'http://localhost:3000/app.js?v=1', lineno: 3, colno: 4, error: new Error(message), ...extra }))

beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
afterEach(() => { A.shutdown(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('error capture', () => {
  it('captures window errors with source, position and stack; flushes with priority latency', async () => {
    const f = mockFetch()
    A.init(cfg({ autocapture: on }))
    fire('boom')
    await vi.advanceTimersByTimeAsync(1000)
    const [e] = eventsOf(f)
    expect(e.t).toBe('error')
    expect(e.d).toMatchObject({ msg: 'boom', kind: 'error', src: 'http://localhost:3000/app.js', line: 3, col: 4 })
    expect(String(e.d!.stack)).toContain('boom')
  })

  it('truncates stacks to 4000 chars', async () => {
    const f = mockFetch()
    A.init(cfg({ autocapture: on }))
    const err = new Error('big'); err.stack = 's'.repeat(10000)
    fire('big', { error: err })
    await A.flush()
    expect((eventsOf(f)[0].d!.stack as string).length).toBe(4000)
  })

  it('captures failed resource loads as kind=resource with src', async () => {
    const f = mockFetch()
    A.init(cfg({ autocapture: on }))
    const img = document.createElement('img')
    img.src = 'http://localhost:3000/missing.png?sig=abc'
    document.body.appendChild(img)
    img.dispatchEvent(new Event('error'))
    await A.flush()
    expect(eventsOf(f)[0].d).toMatchObject({ kind: 'resource', src: 'http://localhost:3000/missing.png' })
  })

  it('captures unhandled rejections (Error and non-Error reasons)', async () => {
    const f = mockFetch()
    A.init(cfg({ autocapture: on }))
    const rej = (reason: unknown) => { const e = new Event('unhandledrejection'); Object.assign(e, { reason }); window.dispatchEvent(e) }
    rej(new TypeError('nope'))
    rej('just a string')
    await A.flush()
    const [a, b] = eventsOf(f)
    expect(a.d).toMatchObject({ kind: 'rejection', msg: 'nope' })
    expect(a.d!.stack).toBeTruthy()
    expect(b.d).toMatchObject({ kind: 'rejection', msg: 'just a string' })
  })

  it('captureException works even with error autocapture off', async () => {
    const f = mockFetch()
    A.init(cfg())
    A.captureException(new Error('handled'), { order: 7 })
    A.captureException('plain')
    await A.flush()
    const [a, b] = eventsOf(f)
    expect(a.d).toMatchObject({ kind: 'manual', msg: 'handled', extra: { order: 7 } })
    expect(b.d).toMatchObject({ kind: 'manual', msg: 'plain' })
  })
})

describe('error storm protection', () => {
  it('coalesces identical errors within 5s into count on the queued event', async () => {
    const f = mockFetch()
    A.init(cfg({ autocapture: on }))
    fire('same'); fire('same'); fire('same')
    await vi.advanceTimersByTimeAsync(500) // still queued (priority flush is at 1000ms)
    fire('same')
    await A.flush()
    const es = eventsOf(f)
    expect(es).toHaveLength(1)
    expect(es[0].d!.count).toBe(4)
  })

  it('keeps coalescing while the occurrences stay within 5s of each other', async () => {
    const f = mockFetch()
    A.init(cfg({ autocapture: on, priorityFlushDelay: 60000, flushInterval: 60000 }))
    for (let i = 0; i < 4; i++) { fire('same'); await vi.advanceTimersByTimeAsync(4000) }
    fire('same')
    await A.flush()
    expect(eventsOf(f)).toHaveLength(1)
    expect(eventsOf(f)[0].d!.count).toBe(5)
  })

  it('does not coalesce different errors, nor after 5s, nor once the original was sent', async () => {
    const f = mockFetch()
    A.init(cfg({ autocapture: on }))
    fire('a'); fire('b'); fire('a', { lineno: 99 })
    await vi.advanceTimersByTimeAsync(1000) // sent
    fire('a', { lineno: 99 })
    await vi.advanceTimersByTimeAsync(6000)
    fire('a', { lineno: 99 })
    await A.flush()
    expect(eventsOf(f)).toHaveLength(5)
  })

  it('drops errors beyond 30 per minute and recovers afterwards', async () => {
    const f = mockFetch()
    A.init(cfg({ autocapture: on, maxBatchSize: 1000 }))
    for (let i = 0; i < 50; i++) fire('err ' + i)
    await A.flush()
    expect(eventsOf(f)).toHaveLength(30)
    await vi.advanceTimersByTimeAsync(60001)
    fire('later')
    await A.flush()
    expect(eventsOf(f)).toHaveLength(31)
  })
})
