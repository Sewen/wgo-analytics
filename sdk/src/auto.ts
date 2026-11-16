import { init, status } from './index'
import type { Config } from './types'

export * from './index'

type W = Window & { WGOConfig?: Config }
const flag = (v: string | undefined) => v === '' || v === 'true'

/** The SDK is served from the same host that ingests events, so the endpoint defaults to the script's origin. */
function originOf(s: HTMLScriptElement | null): string | undefined {
  try {
    return s?.src ? new URL(s.src, location.href).origin : undefined
  } catch {
    return undefined
  }
}

function fromScript(s: HTMLScriptElement | null): Config | null {
  const d = s?.dataset
  const endpoint = d?.endpoint?.trim() || originOf(s)
  if (!d?.writeKey || !endpoint) return null
  return {
    writeKey: d.writeKey,
    endpoint,
    debug: flag(d.debug),
    release: d.release,
    environment: d.environment,
    captureQueryParams: flag(d.captureQueryParams),
    respectDoNotTrack: flag(d.respectDoNotTrack),
  }
}

/**
 * Config sources, in order: `window.WGOConfig = { writeKey, endpoint, … }` (handy for tag managers
 * and frameworks), our own <script> tag, then any script tag carrying the data attributes. Frameworks
 * and tag managers often re-create script elements, so currentScript alone isn't reliable.
 */
function findConfig(own: HTMLScriptElement | null): Config | null {
  const w = window as W
  const g = w.WGOConfig
  if (g?.writeKey) {
    const endpoint = g.endpoint || originOf(own)
    if (endpoint) return { ...g, endpoint }
  }
  const candidates = [own, ...Array.from(document.querySelectorAll<HTMLScriptElement>('script[data-write-key]'))]
  for (const s of candidates) {
    const c = fromScript(s)
    if (c) return c
  }
  return null
}

if (typeof document !== 'undefined') {
  // Captured synchronously: document.currentScript is null once the script has finished executing.
  const own = document.currentScript as HTMLScriptElement | null
  const tryInit = () => {
    if (status().initialized) return true
    const cfg = findConfig(own)
    if (cfg) init(cfg)
    return status().initialized || status().disabled
  }
  if (!tryInit()) {
    // The tag's attributes (or window.WGOConfig) may only appear once the page has rendered.
    const retry = () => {
      if (tryInit()) return
      setTimeout(() => {
        if (!tryInit())
          console.warn(
            '[wgo] loaded but not initialised: no data-write-key found on the script tag. ' +
              'Add it, set window.WGOConfig = { writeKey } before loading, or call WGO.init({ writeKey, endpoint }).',
          )
      }, 2000)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', retry, { once: true })
    else retry()
  }
}
