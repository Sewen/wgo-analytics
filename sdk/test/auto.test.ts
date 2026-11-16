import { afterEach, describe, expect, it, vi } from 'vitest'
import { INGEST, batchOf, mockFetch } from './helpers'

afterEach(async () => {
  const { shutdown } = await import('../src/index')
  shutdown()
  vi.resetModules()
  vi.unstubAllGlobals()
  Object.defineProperty(document, 'currentScript', { value: null, configurable: true })
  delete (window as { WGOConfig?: unknown }).WGOConfig
  document.querySelectorAll('script[data-write-key]').forEach((s) => s.remove())
  vi.useRealTimers()
})

describe('script-tag auto-init', () => {
  it('reads data-* attributes from document.currentScript', async () => {
    const f = mockFetch()
    const s = document.createElement('script')
    Object.assign(s.dataset, { writeKey: 'wk_auto', endpoint: 'https://api.test/', release: 'r9', environment: 'staging' })
    Object.defineProperty(document, 'currentScript', { value: s, configurable: true })
    const mod = await import('../src/auto')
    await mod.flush()
    expect(String(f.mock.calls[0][0])).toBe(INGEST)
    const b = batchOf(f.mock.calls[0])
    expect(b.k).toBe('wk_auto')
    expect(b.ctx).toMatchObject({ release: 'r9', env: 'staging' })
    expect(b.e[0].t).toBe('pageview')
  })

  it('stays idle without a write key', async () => {
    const f = mockFetch()
    await import('../src/auto')
    expect(f).not.toHaveBeenCalled()
  })

  it('finds its tag when currentScript is unusable (framework or tag manager re-created the element)', async () => {
    const f = mockFetch()
    const s = document.createElement('script')
    Object.assign(s.dataset, { writeKey: 'wk_found', endpoint: 'https://api.test' })
    document.head.appendChild(s)
    const mod = await import('../src/auto')
    expect(mod.status()).toMatchObject({ initialized: true, endpoint: 'https://api.test' })
    await mod.flush()
    expect(batchOf(f.mock.calls[0]).k).toBe('wk_found')
  })

  it('accepts window.WGOConfig', async () => {
    const f = mockFetch()
    ;(window as { WGOConfig?: unknown }).WGOConfig = { writeKey: 'wk_global', endpoint: 'https://api.test' }
    const mod = await import('../src/auto')
    await mod.flush()
    expect(batchOf(f.mock.calls[0]).k).toBe('wk_global')
  })

  it('shares one client when the SDK is loaded twice', async () => {
    const f = mockFetch()
    ;(window as { WGOConfig?: unknown }).WGOConfig = { writeKey: 'wk_twice', endpoint: 'https://api.test' }
    const first = await import('../src/auto')
    vi.resetModules() // a second, independent copy of the bundle
    const second = await import('../src/auto')
    second.track('from_second_copy')
    await first.flush()
    const events = f.mock.calls.flatMap((c) => batchOf(c).e)
    expect(events.filter((e) => e.t === 'pageview')).toHaveLength(1) // not one per copy
    expect(events.some((e) => e.t === 'custom' && (e.d as { name: string }).name === 'from_second_copy')).toBe(true)
  })

  it('warns when it cannot find any configuration', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetch()
    const mod = await import('../src/auto')
    expect(mod.status().initialized).toBe(false)
    vi.advanceTimersByTime(2500)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('loaded but not initialised'))
    warn.mockRestore()
  })

  it('defaults the endpoint to the origin the script was served from (empty or missing data-endpoint)', async () => {
    const f = mockFetch()
    const s = document.createElement('script')
    s.src = 'https://d123.cloudfront.net/sdk/v1/wgo.js'
    Object.assign(s.dataset, { writeKey: 'wk_origin', endpoint: '' }) // as pasted in the wild
    Object.defineProperty(document, 'currentScript', { value: s, configurable: true })
    const mod = await import('../src/auto')
    await mod.flush()
    expect(String(f.mock.calls[0][0])).toBe('https://d123.cloudfront.net/ingest')
    expect(mod.status().endpoint).toBe('https://d123.cloudfront.net')
  })
})
