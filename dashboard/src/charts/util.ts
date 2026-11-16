import { useEffect, useRef, useState } from 'react';

export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
export function niceMax(max: number, ticks = 4): { max: number; step: number } {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}
export function fmtTick(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs <= 2 * 86400e3) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
}
export function fmtTipTime(t: number, spanMs: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: spanMs <= 3600e3 ? '2-digit' : undefined });
  return spanMs <= 3600e3 ? time : d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' ' + time;
}
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return +(n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return +(n / 1e3).toFixed(1) + 'k';
  return String(+n.toFixed(2));
}
