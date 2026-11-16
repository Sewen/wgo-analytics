import { ls, uuid } from './util'

interface Rec { id: string; last: number; smp: 0 | 1 }

export class Session {
  readonly aid: string
  uid?: string
  private cur?: Rec
  private wrote = 0

  constructor(private timeout: number, private sampleRate: number) {
    let a = ls.get('wgo:aid')
    if (!a) { a = uuid(); ls.set('wgo:aid', a) }
    this.aid = a
    this.uid = ls.get('wgo:uid') || undefined
  }

  private read(): Rec | undefined {
    try {
      const r = JSON.parse(ls.get('wgo:sid') || 'null')
      if (r && typeof r.id === 'string' && typeof r.last === 'number') return r
    } catch { /* corrupt */ }
    return undefined
  }

  /** Marks activity; rotates the session after `timeout` of inactivity. Sampling is decided once per session. */
  touch(): { id: string; sampled: boolean } {
    const now = Date.now()
    let r = this.read() || this.cur // storage first: other tabs share the session
    let fresh = false
    if (!r || now - r.last > this.timeout) {
      r = { id: uuid(), last: now, smp: this.sampleRate >= 1 || Math.random() < this.sampleRate ? 1 : 0 }
      fresh = true
    } else r.last = now
    this.cur = r
    if (fresh || now - this.wrote >= 1000) { this.wrote = now; ls.set('wgo:sid', JSON.stringify(r)) }
    return { id: r.id, sampled: r.smp === 1 }
  }

  identify(id: string): void {
    this.uid = id
    ls.set('wgo:uid', id)
  }
}
