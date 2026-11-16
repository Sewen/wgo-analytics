export const nf = new Intl.NumberFormat('en-US');
export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  if (a < 10 && !Number.isInteger(n)) return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return nf.format(Math.round(n));
}
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '–';
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
  if (ms >= 1000) return (ms / 1000).toFixed(2).replace(/\.?0+$/, '') + 's';
  if (ms >= 10) return Math.round(ms) + 'ms';
  return ms.toFixed(1).replace(/\.0$/, '') + 'ms';
}
export function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + (Math.abs(n) >= 100 ? Math.round(n) : n.toFixed(1)) + '%';
}
export function delta(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return ((cur - prev) / prev) * 100;
}
export function relTime(iso: string | number, now = Date.now()): string {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = Math.round((now - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function fmtTime(iso: string, withDate = false): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return withDate ? d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) + ' ' + t : t;
}
export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function shortId(id: string | null, n = 8): string {
  return id ? id.slice(0, n) : '–';
}
export function copy(text: string): Promise<void> {
  return navigator.clipboard?.writeText(text).catch(() => fallbackCopy(text)) ?? Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
}
export function cn(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ');
}
