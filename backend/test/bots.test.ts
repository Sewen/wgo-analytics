import { describe, expect, it } from 'vitest';
import { botReason, offsetMinutes, timezoneMismatch } from '../src/lib/bots';
import { normalizeBatch, type WireBatch } from '../src/lib/events';
import { NO_GEO } from '../src/lib/geo';

describe('time zone vs location', () => {
  const WINTER = new Date('2026-01-15T12:00:00Z');
  const SUMMER = new Date('2026-07-15T12:00:00Z');
  it.each([
    ['Asia/Shanghai', 'DE', true], // the scraper: Chinese clock, German proxy
    ['Asia/Shanghai', 'JP', true], // …and Japanese proxy: +8 vs Japan's +9
    ['Asia/Shanghai', 'IN', true], // …and Indian proxy: +8 vs +5:30
    ['UTC', 'DE', true], // headless browsers on servers default to UTC
    ['UTC', 'IL', true],
    ['UTC', 'GB', false], // London is UTC in winter
    ['UTC', 'IS', false], // Iceland is always UTC
    ['Europe/Stockholm', 'SE', false],
    ['Europe/Paris', 'SE', false], // same offset
    ['Europe/Stockholm', 'NL', false], // a Swedish VPN user exiting in Amsterdam
    ['America/New_York', 'US', false],
    ['America/Los_Angeles', 'US', false],
    ['Pacific/Honolulu', 'US', false], // Hawaii
    ['Asia/Yekaterinburg', 'RU', false], // Russia's eleven zones
    ['Asia/Kolkata', 'IN', false],
    ['Asia/Calcutta', 'IN', false], // legacy alias still resolves
    ['Atlantic/Canary', 'ES', false],
    ['Australia/Sydney', 'AU', false],
    ['Asia/Shanghai', 'CN', false],
    ['Asia/Tokyo', null, false], // no location: no signal
    ['Not/AZone', 'DE', false], // unknown zone: no signal
  ])('%s from %s (winter) → mismatch %s', (tz, country, expected) => expect(timezoneMismatch(tz, country, WINTER)).toBe(expected));

  it('compares offsets at the event time (DST)', () => {
    expect(timezoneMismatch('UTC', 'GB', SUMMER)).toBe(true); // London is UTC+1 in summer
    expect(timezoneMismatch('Europe/London', 'GB', SUMMER)).toBe(false);
    expect(timezoneMismatch('Australia/Sydney', 'AU', SUMMER)).toBe(false); // southern-hemisphere winter
    expect(offsetMinutes('Asia/Kolkata', WINTER)).toBe(330);
    expect(offsetMinutes('America/St_Johns', WINTER)).toBe(-210);
  });
});

describe('bot reason', () => {
  it('prefers the strongest signal', () => {
    expect(botReason({ uaIsBot: true, webdriver: true, tz: 'Asia/Shanghai', country: 'DE' })).toBe('user-agent');
    expect(botReason({ uaIsBot: false, webdriver: true, tz: 'Europe/Berlin', country: 'DE' })).toBe('automation');
    expect(botReason({ uaIsBot: false, tz: 'Asia/Shanghai', country: 'DE' })).toBe('timezone-mismatch');
    expect(botReason({ uaIsBot: false, webdriver: false, tz: 'Europe/Berlin', country: 'DE' })).toBeNull();
    expect(botReason({ uaIsBot: false, tz: 42, country: 'DE' })).toBeNull();
  });

  it('flags every event of a batch at ingest', () => {
    const now = Date.now();
    const batch = (ctx: Record<string, unknown>): WireBatch => ({
      k: 'k', a: 'a', sentAt: now, ctx: { sdk: 'wgo-js/0.1.0', ...ctx },
      e: [{ id: 'x', t: 'pageview', ts: now, s: 's', url: 'https://pingis.net/player', path: '/player' }, { id: 'y', t: 'click', ts: now, s: 's', url: 'https://pingis.net/player', path: '/player', d: { sel: 'a', tag: 'a' } }],
    });
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1';
    const de = { ...NO_GEO, country: 'DE', city: 'Frankfurt am Main' };
    // the scraper seen in production: mobile Chrome, en-US, Asia/Shanghai, rotating proxies
    expect(normalizeBatch('p', batch({ ua: iphone, tz: 'Asia/Shanghai', lang: 'en-US', sw: 375, sh: 812 }), now, undefined, de).map((r) => r.bot))
      .toEqual(['timezone-mismatch', 'timezone-mismatch']);
    expect(normalizeBatch('p', batch({ ua: iphone, tz: 'Europe/Berlin' }), now, undefined, de).map((r) => r.bot)).toEqual([null, null]);
    expect(normalizeBatch('p', batch({ ua: iphone, tz: 'Europe/Berlin', wd: true }), now, undefined, de)[0].bot).toBe('automation');
    expect(normalizeBatch('p', batch({ ua: 'Mozilla/5.0 HeadlessChrome/131.0', tz: 'Europe/Berlin' }), now, undefined, de)[0].bot).toBe('user-agent');
    // no location (e.g. sent to the API URL directly): time zone alone decides nothing
    expect(normalizeBatch('p', batch({ ua: iphone, tz: 'Asia/Shanghai' }), now, undefined, NO_GEO)[0].bot).toBeNull();
  });
});
