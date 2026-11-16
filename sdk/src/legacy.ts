import { ls } from './util'

/**
 * One-time move of visitor state stored under the SDK's pre-release name, so returning visitors keep their
 * anonymous id and session, and unsent events aren't lost. Safe to delete once old installs have upgraded.
 */
const OLD = 'analytico:'

export function migrateStorage(writeKey: string): void {
  for (const k of ['aid', 'sid', 'uid', `q:${writeKey}`]) {
    const old = ls.get(OLD + k)
    if (old === null) continue
    if (ls.get('wgo:' + k) === null) ls.set('wgo:' + k, old)
    ls.del(OLD + k)
  }
}
