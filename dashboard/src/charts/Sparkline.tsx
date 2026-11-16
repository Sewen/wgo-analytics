import { useId } from 'react';

export function Sparkline({ data, color = 'var(--s1)', height = 32, fill = true, className }: { data: number[]; color?: string; height?: number; fill?: boolean; className?: string }) {
  const id = useId();
  if (data.length < 2) return <div style={{ height }} className={className} />;
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const W = 100, pad = 2;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * W, height - pad - ((v - min) / (max - min || 1)) * (height - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" width="100%" height={height} className={className} aria-hidden>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".32" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {fill && <path d={`${line} L${W} ${height} L0 ${height} Z`} fill={`url(#${id})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
