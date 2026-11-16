// Shared by GeoMap and its callers. Kept apart so importing these doesn't pull MapLibre into the main bundle.
export interface GeoMapPoint { lat: number; lon: number; value: number; label: string; sub?: string }
export interface GeoMapPing { id: string; lat: number; lon: number; color: string; strong?: boolean; /** 1 = new, 0 = gone */ life: number }
/** A dot on screen: one place, or a cluster of places (`cells` lists the member map cells). */
export interface CalloutGroup { key: string; lat: number; lon: number; cells: string[]; label: string }
export type CalloutMode = 'off' | 'selected' | 'all';

/** Map cell id for a coordinate pair, matching the backend's 0.1° rounding. */
export const cellKey = (lat: number, lon: number) => `${lat.toFixed(1)},${lon.toFixed(1)}`;
