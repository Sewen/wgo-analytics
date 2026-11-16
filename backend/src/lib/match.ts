import type { AnalyticsEvent, Watch } from '../contract';

const has = (hay: string | null | undefined, needle: string) => !!hay && hay.toLowerCase().includes(needle.toLowerCase());

/** Every provided watch field must match (case-insensitive substring); omitted fields are wildcards. */
export function matchesWatch(w: Watch, e: AnalyticsEvent): boolean {
  if (w.type && w.type !== e.type) return false;
  if (w.selector && !has(e.selector, w.selector)) return false;
  if (w.text && !has(e.elementText, w.text)) return false;
  if (w.name && !has(e.type === 'custom' ? e.name : e.trackName, w.name)) return false;
  if (w.path && !has(e.path, w.path)) return false;
  return true;
}

export function sanitizeWatches(input: unknown): Watch[] {
  if (!Array.isArray(input)) return [];
  const clip = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 256) : undefined);
  return input.slice(0, 50).flatMap((w): Watch[] => {
    if (!w || typeof w !== 'object') return [];
    const o = w as Record<string, unknown>;
    const id = clip(o.id);
    if (!id) return [];
    return [
      {
        id,
        label: clip(o.label) ?? id,
        type: (clip(o.type) ?? 'click') as Watch['type'],
        selector: clip(o.selector),
        text: clip(o.text),
        name: clip(o.name),
        path: clip(o.path),
      },
    ];
  });
}
