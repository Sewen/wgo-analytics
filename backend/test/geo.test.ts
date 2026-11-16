import { describe, expect, it } from 'vitest';
import { geoFromHeaders, NO_GEO } from '../src/lib/geo';
import { normalizeBatch, toApiEvent } from '../src/lib/events';

const cf = {
  'cloudfront-viewer-country': 'SE',
  'cloudfront-viewer-country-region-name': 'Stockholm County',
  'cloudfront-viewer-city': 'S%C3%B6dert%C3%A4lje',
  'cloudfront-viewer-latitude': '59.19554',
  'cloudfront-viewer-longitude': '17.62525',
};

describe('geoFromHeaders', () => {
  it('parses CloudFront headers, decodes names and rounds coordinates to ~11 km', () => {
    expect(geoFromHeaders(cf, '')).toEqual({ country: 'SE', region: 'Stockholm County', city: 'Södertälje', lat: 59.2, lon: 17.6 });
  });

  it('only trusts headers vouched for by our CloudFront distribution when a secret is configured', () => {
    expect(geoFromHeaders(cf, 'secret')).toEqual(NO_GEO); // forged: called API Gateway directly
    expect(geoFromHeaders({ ...cf, 'x-analytico-edge': 'nope' }, 'secret')).toEqual(NO_GEO);
    expect(geoFromHeaders({ ...cf, 'x-analytico-edge': 'secret' }, 'secret').country).toBe('SE');
  });

  it('rejects garbage', () => {
    expect(geoFromHeaders({ 'cloudfront-viewer-country': 'Sweden', 'cloudfront-viewer-latitude': '95', 'cloudfront-viewer-longitude': '10' }, '')).toEqual(NO_GEO);
    expect(geoFromHeaders({ 'cloudfront-viewer-latitude': '10' }, '').lat).toBeNull(); // lat without lon
    expect(geoFromHeaders(undefined, '')).toEqual(NO_GEO);
  });

  it('attaches the location to every event of the batch', () => {
    const now = Date.now();
    const rows = normalizeBatch('p', { k: 'k', a: 'a', sentAt: now, e: [{ id: 'x', t: 'pageview', ts: now, s: 's', url: 'https://x.test/', path: '/' }] }, now, undefined, geoFromHeaders(cf, ''));
    expect(toApiEvent(rows[0])).toMatchObject({ country: 'SE', city: 'Södertälje', lat: 59.2, lon: 17.6 });
  });
});
