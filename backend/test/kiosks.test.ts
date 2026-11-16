import { describe, expect, it } from 'vitest';
import { DEFAULT_KIOSK_CONFIG, generateKioskToken, sanitizeKioskConfig } from '../src/lib/kiosks';

describe('kiosk config', () => {
  it('defaults to the overview when no config is given', () => {
    expect(sanitizeKioskConfig(undefined)).toEqual(DEFAULT_KIOSK_CONFIG);
  });

  it('keeps valid screens and drops what does not belong', () => {
    const c = sanitizeKioskConfig({
      screens: [
        { page: 'errors', params: '?range=1h&f=[{"field":"path","op":"eq","value":"/checkout"}]', title: '  Checkout errors  ', watches: [{ id: 'w1', label: 'x' }] },
        { page: 'live', params: '', watches: [{ id: 'w1', label: 'Signup', type: 'click', selector: '#signup' }, { label: 'no id' }] },
      ],
      rotateSeconds: 30,
      refreshSeconds: 20.4,
      theme: 'light',
      zoom: 1.256,
      extra: 'ignored',
    });
    expect(c).toEqual({
      screens: [
        { page: 'errors', params: 'range=1h&f=[{"field":"path","op":"eq","value":"/checkout"}]', title: 'Checkout errors' }, // watches only on live
        { page: 'live', params: '', watches: [{ id: 'w1', label: 'Signup', type: 'click', selector: '#signup' }] },
      ],
      rotateSeconds: 30,
      refreshSeconds: 20,
      theme: 'light',
      zoom: 1.26,
    });
  });

  it('lays a partial config over the current one (PATCH)', () => {
    const cur = sanitizeKioskConfig({ ...DEFAULT_KIOSK_CONFIG, theme: 'light', zoom: 2 });
    expect(sanitizeKioskConfig({ rotateSeconds: 15 }, cur)).toEqual({ ...cur, rotateSeconds: 15 });
  });

  it('rejects invalid values with a readable message', () => {
    const bad = (config: unknown) => () => sanitizeKioskConfig(config);
    expect(bad({ screens: [] })).toThrow('1 to 12 screens');
    expect(bad({ screens: Array(13).fill({ page: 'overview', params: '' }) })).toThrow('1 to 12 screens');
    expect(bad({ screens: [{ page: 'settings', params: '' }] })).toThrow('Screen 1: page must be one of');
    expect(bad({ screens: [{ page: 'overview', params: 'x'.repeat(4001) }] })).toThrow('longer than 4000');
    expect(bad({ rotateSeconds: 5 })).toThrow('rotateSeconds must be between 10 and 3600');
    expect(bad({ refreshSeconds: '60' })).toThrow('refreshSeconds');
    expect(bad({ zoom: 4 })).toThrow('zoom');
    expect(bad({ theme: 'blue' })).toThrow('theme');
    expect(bad([1])).toThrow('config must be an object');
  });

  it('generates long, URL-safe tokens', () => {
    const a = generateKioskToken();
    expect(a).toMatch(/^ks_[A-Za-z0-9]{40}$/);
    expect(generateKioskToken()).not.toBe(a);
  });
});
