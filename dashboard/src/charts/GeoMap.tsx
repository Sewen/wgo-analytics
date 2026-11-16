/// <reference types="geojson" />
/**
 * Zoomable visitor map: OpenStreetMap vector tiles (OpenFreeMap, no API key) rendered with MapLibre GL.
 * Lazy-loaded: MapLibre is large and only these two cards need it.
 */
import maplibregl, { type GeoJSONSource, type MapGeoJSONFeature, type Map as MLMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getConfig } from '../api/config';
import { fmtNum } from '../lib/format';

import { cellKey, type CalloutGroup, type CalloutMode, type GeoMapPing, type GeoMapPoint } from './geoTypes';
const MAX_ALL_CALLOUTS = 20;

const STYLES = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
};
const SRC = 'visitors';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function useTheme(): 'dark' | 'light' {
  return useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return () => mo.disconnect();
    },
    () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'),
  );
}

const toGeoJSON = (points: GeoMapPoint[]): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: points.map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { value: p.value, label: p.label, sub: p.sub ?? '', cell: cellKey(p.lat, p.lon) },
  })),
});

/** Marker size scales with sqrt(value) relative to the biggest place; clusters (sums) cap at the max size. */
function sizeExpr(max: number, base: number, span: number): maplibregl.ExpressionSpecification {
  return ['+', base, ['*', span, ['sqrt', ['min', 1, ['/', ['get', 'value'], Math.max(1, max)]]]]];
}

function setData(m: MLMap, points: GeoMapPoint[], fit: boolean, unitMax: number) {
  (m.getSource(SRC) as GeoJSONSource | undefined)?.setData(toGeoJSON(points));
  m.setPaintProperty('v-glow', 'circle-radius', sizeExpr(unitMax, 10, 30));
  m.setPaintProperty('v-core', 'circle-radius', sizeExpr(unitMax, 3.5, 4));
  if (!fit || !points.length) return;
  if (points.length === 1) {
    m.jumpTo({ center: [points[0].lon, points[0].lat], zoom: 3.5 });
    return;
  }
  const b = new maplibregl.LngLatBounds();
  for (const p of points) b.extend([p.lon, p.lat]);
  m.fitBounds(b, { padding: 60, maxZoom: 4.5, duration: 0 });
}

/** Popup content built from DOM nodes (city names come from request headers; never inject them as HTML). */
function popupNode(title: string, line: string): HTMLElement {
  const root = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'geo-pop-title';
  t.textContent = title;
  const l = document.createElement('div');
  l.className = 'geo-pop-sub';
  l.textContent = line;
  root.append(t, l);
  return root;
}

type Props = {
  points?: GeoMapPoint[]; pings?: GeoMapPing[]; height?: number; unit?: string; fit?: boolean;
  /** 'selected': clicking a dot shows its callout; 'all': every visible dot gets one */
  callouts?: CalloutMode;
  renderCallout?: (g: CalloutGroup) => ReactNode | null;
};

/**
 * Nudge each callout sideways so it stays inside the map, and flip it below its dot near the top edge.
 * The tail keeps pointing at the dot via --tail-dx.
 */
function placeCallouts(m: MLMap, els: Map<string, { marker: maplibregl.Marker; el: HTMLElement }>) {
  const { width } = m.getContainer().getBoundingClientRect();
  const PAD = 8;
  for (const { marker, el } of els.values()) {
    const box = el.firstElementChild as HTMLElement | null;
    if (!box) continue;
    const p = m.project(marker.getLngLat());
    const w = box.offsetWidth, h = box.offsetHeight;
    const left = p.x - w / 2;
    const dx = left < PAD ? PAD - left : left + w > width - PAD ? width - PAD - (left + w) : 0;
    const below = p.y - 12 - h < PAD;
    box.style.transform = `translate(${Math.round(dx)}px, ${below ? h + 28 : 0}px)`;
    box.style.setProperty('--tail-dx', `${Math.round(-dx)}px`);
    box.classList.toggle('geo-callout-below', below);
  }
}

/** Resolve a rendered feature (place or cluster) into a callout group. */
async function toGroup(m: MLMap, f: MapGeoJSONFeature): Promise<CalloutGroup | null> {
  if (f.geometry.type !== 'Point') return null;
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties as { cluster_id?: number; point_count?: number; cell?: string; label?: string };
  if (p.cluster_id === undefined) return { key: `p:${p.cell}`, lat, lon, cells: [p.cell!], label: p.label ?? '' };
  const leaves = await (m.getSource(SRC) as GeoJSONSource).getClusterLeaves(p.cluster_id, 500, 0);
  const props = leaves.map((l) => l.properties as { cell: string; label: string; value: number });
  const top = props.reduce((a, b) => (b.value > a.value ? b : a), props[0]);
  return { key: `c:${props.map((x) => x.cell).sort().join('|')}`, lat, lon, cells: props.map((x) => x.cell), label: `${top?.label ?? ''} +${props.length - 1} nearby` };
}

export default function GeoMap({ points = [], pings = [], height = 380, unit = 'sessions', fit = true, callouts = 'off', renderCallout }: Props) {
  const [selected, setSelected] = useState<CalloutGroup | null>(null);
  const [visible, setVisible] = useState<CalloutGroup[]>([]);
  const calloutEls = useRef(new Map<string, { marker: maplibregl.Marker; el: HTMLElement }>());
  const mode = useRef(callouts);
  mode.current = callouts;
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const fitted = useRef(false);
  const markers = useRef(new Map<string, { marker: maplibregl.Marker; el: HTMLElement }>());
  const theme = useTheme();
  const max = Math.max(1, ...points.map((p) => p.value));
  const latest = useRef({ points, max, fit });
  latest.current = { points, max, fit };

  // (re)create the map; a theme switch swaps the whole style, so rebuilding is simplest
  useEffect(() => {
    const cfg = getConfig() as { mapStyleUrl?: string; mapStyleUrlLight?: string };
    const style = theme === 'light' ? cfg.mapStyleUrlLight ?? STYLES.light : cfg.mapStyleUrl ?? STYLES.dark;
    const m = new maplibregl.Map({
      container: el.current!,
      style,
      center: [12, 28],
      zoom: 0.9,
      minZoom: 0.6,
      maxZoom: 12,
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      cooperativeGestures: true, // plain scroll keeps scrolling the page; ⌘/Ctrl + scroll zooms
      attributionControl: { compact: true },
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.FullscreenControl(), 'top-right');

    m.on('load', () => {
      m.addSource(SRC, {
        type: 'geojson',
        data: EMPTY,
        cluster: true,
        clusterRadius: 42,
        clusterMaxZoom: 9,
        clusterProperties: { value: ['+', ['get', 'value']] },
      });
      m.addLayer({
        id: 'v-glow', type: 'circle', source: SRC,
        paint: { 'circle-color': '#8b7cf6', 'circle-opacity': 0.3, 'circle-blur': 0.85, 'circle-radius': 10 },
      });
      m.addLayer({
        id: 'v-core', type: 'circle', source: SRC,
        paint: {
          'circle-color': '#22d3ee', 'circle-radius': 5,
          'circle-stroke-color': theme === 'light' ? '#ffffff' : '#0a0a0f', 'circle-stroke-width': 1.5,
        },
      });
      ready.current = true;
      const l = latest.current;
      setData(m, l.points, l.fit && !fitted.current, l.max);
      if (l.points.length) fitted.current = true;
    });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: 'geo-pop' });
    const describe = (f: MapGeoJSONFeature) => {
      const p = f.properties as { value: number; label?: string; sub?: string; point_count?: number };
      const value = `${fmtNum(p.value)} ${unit}`;
      return p.point_count ? popupNode(`${p.point_count} places`, `${value} · click to zoom in`) : popupNode(p.label ?? '', p.sub ? `${value} · ${p.sub}` : value);
    };
    m.on('mousemove', 'v-glow', (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      m.getCanvas().style.cursor = 'pointer';
      popup.setLngLat(f.geometry.coordinates as [number, number]).setDOMContent(describe(f)).addTo(m);
    });
    m.on('mouseleave', 'v-glow', () => {
      m.getCanvas().style.cursor = '';
      popup.remove();
    });
    m.on('click', 'v-glow', async (e) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== 'Point') return;
      if (mode.current === 'selected') {
        const g = await toGroup(m, f);
        setSelected((cur) => (cur && g && cur.key === g.key ? null : g));
        return;
      }
      const center = f.geometry.coordinates as [number, number];
      const id = (f.properties as { cluster_id?: number }).cluster_id;
      const zoom = id !== undefined ? await (m.getSource(SRC) as GeoJSONSource).getClusterExpansionZoom(id) : Math.max(m.getZoom() + 2, 6);
      m.easeTo({ center, zoom });
    });
    m.on('click', (e) => {
      // clicking empty map clears the selection
      if (!m.queryRenderedFeatures(e.point, { layers: ['v-glow'] }).length) setSelected(null);
    });

    // 'all' mode: one callout per dot currently on screen (biggest first), recomputed when the view settles
    let sig = '';
    const refreshVisible = async () => {
      if (mode.current !== 'all' || !m.getLayer('v-core')) return;
      const seen = new Map<string, MapGeoJSONFeature>();
      for (const f of m.queryRenderedFeatures({ layers: ['v-core'] })) {
        const p = f.properties as { cluster_id?: number; cell?: string; value: number };
        seen.set(p.cluster_id !== undefined ? `c${p.cluster_id}` : `p${p.cell}`, f);
      }
      const top = [...seen.values()].sort((a, b) => (b.properties.value as number) - (a.properties.value as number)).slice(0, MAX_ALL_CALLOUTS);
      const groups = (await Promise.all(top.map((f) => toGroup(m, f)))).filter((g): g is CalloutGroup => !!g);
      const next = groups.map((g) => g.key).join(';');
      if (next !== sig) {
        sig = next;
        setVisible(groups);
      }
    };
    m.on('idle', refreshVisible);
    m.on('move', () => placeCallouts(m, calloutEls.current));

    map.current = m;
    const mk = markers.current;
    const co = calloutEls.current;
    return () => {
      popup.remove();
      mk.forEach(({ marker }) => marker.remove());
      mk.clear();
      co.forEach(({ marker }) => marker.remove());
      co.clear();
      m.remove();
      map.current = null;
      ready.current = false;
    };
  }, [theme, unit]);

  // data updates
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    setData(m, points, fit && !fitted.current, max);
    if (points.length) fitted.current = true;
  }, [points, fit, max]);

  // live pings as DOM markers (CSS ripple), faded by age and removed when gone
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const live = markers.current;
    const seen = new Set<string>();
    for (const p of pings) {
      seen.add(p.id);
      let entry = live.get(p.id);
      if (!entry) {
        const node = document.createElement('div');
        node.className = p.strong ? 'geo-ping geo-ping-strong' : 'geo-ping';
        node.style.color = p.color;
        entry = { marker: new maplibregl.Marker({ element: node }).setLngLat([p.lon, p.lat]).addTo(m), el: node };
        live.set(p.id, entry);
      }
      entry.el.style.opacity = String(Math.max(0, p.life));
    }
    for (const [id, { marker }] of live) {
      if (!seen.has(id)) {
        marker.remove();
        live.delete(id);
      }
    }
  }, [pings]);

  // re-evaluate visible dots when switching into 'all'
  useEffect(() => {
    if (callouts === 'all') map.current?.fire('idle');
    if (callouts !== 'selected') setSelected(null);
  }, [callouts]);

  // keep callouts inside the map after every render (content size may have changed)
  useEffect(() => {
    if (map.current) placeCallouts(map.current, calloutEls.current);
  });

  // callout markers: anchored DOM nodes whose content React renders through portals
  const groups = callouts === 'all' ? visible : callouts === 'selected' && selected ? [selected] : [];
  const [, force] = useState(0);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const live = calloutEls.current;
    let changed = false;
    const keys = new Set(groups.map((g) => g.key));
    for (const g of groups) {
      if (live.has(g.key)) continue;
      const node = document.createElement('div');
      node.className = 'geo-callout-anchor';
      live.set(g.key, { marker: new maplibregl.Marker({ element: node, anchor: 'bottom', offset: [0, -12] }).setLngLat([g.lon, g.lat]).addTo(m), el: node });
      changed = true;
    }
    for (const [k, { marker }] of live) {
      if (!keys.has(k)) {
        marker.remove();
        live.delete(k);
        changed = true;
      }
    }
    if (changed) force((x) => x + 1); // render portals into the new nodes
  });

  return (
    <>
      <div ref={el} className="geo-map overflow-hidden rounded-xl" style={{ height }} />
      {renderCallout &&
        groups.map((g) => {
          const node = calloutEls.current.get(g.key)?.el;
          if (!node) return null;
          const content = renderCallout(g);
          return content ? createPortal(content, node, g.key) : null;
        })}
    </>
  );
}
