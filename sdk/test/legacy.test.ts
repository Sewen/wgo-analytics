import { afterEach, describe, expect, it } from 'vitest'
import * as A from '../src/index'
import { cfg, eventsOf, mockFetch, NO_AUTO } from './helpers'

afterEach(() => {
  A.shutdown()
  localStorage.clear()
})

describe('storage from the pre-release name', () => {
  it('moves the visitor id, user id and unsent events to the wgo: keys once', async () => {
    const f = mockFetch()
    localStorage.setItem('analytico:aid', 'old-visitor')
    localStorage.setItem('analytico:uid', 'user-7')
    localStorage.setItem('analytico:q:wk_test', JSON.stringify([{ id: 'queued', t: 'custom', ts: 1, s: 's', url: 'u', path: '/', d: { name: 'queued' } }]))
    A.init(cfg({ autocapture: NO_AUTO, persist: true }))
    await A.flush()
    const sent = eventsOf(f)
    expect(sent.some((e) => e.id === 'queued')).toBe(true) // the unsent event was delivered
    expect(localStorage.getItem('wgo:aid')).toBe('old-visitor')
    expect(localStorage.getItem('wgo:uid')).toBe('user-7')
    expect(Object.keys(localStorage).filter((k) => k.startsWith('analytico:'))).toEqual([])
  })

  it('never overwrites newer wgo: values', () => {
    localStorage.setItem('wgo:aid', 'current')
    localStorage.setItem('analytico:aid', 'old')
    A.init(cfg({ autocapture: NO_AUTO }))
    expect(localStorage.getItem('wgo:aid')).toBe('current')
    expect(localStorage.getItem('analytico:aid')).toBeNull()
  })
})
