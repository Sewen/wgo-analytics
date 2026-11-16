// @vitest-environment node
import { describe, expect, it } from 'vitest'

describe('SSR safety', () => {
  it('imports and calls the API without window/document', async () => {
    expect(typeof window).toBe('undefined')
    const A = await import('../src/index')
    await import('../src/auto')
    expect(() => {
      A.init({ writeKey: 'k', endpoint: 'http://x' })
      A.track('x'); A.identify('u'); A.page(); A.captureException(new Error('x')); A.setContext({}); A.shutdown()
    }).not.toThrow()
    await A.flush()
  })
})
