import { useId } from 'react';
export function LogoMark({ size = 26 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#8b7cf6" /><stop offset="1" stopColor="#22d3ee" /></linearGradient></defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} opacity=".16" />
      <rect x=".5" y=".5" width="31" height="31" rx="8.5" fill="none" stroke={`url(#${id})`} opacity=".6" />
      <path d="M7 21.5 12.5 14l5 4.2L25 9" fill="none" stroke={`url(#${id})`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="9" r="2.2" fill="#22d3ee" />
    </svg>
  );
}
export function Logo({ size = 26 }: { size?: number }) {
  return <div className="flex items-center gap-2.5"><LogoMark size={size} /><span className="text-[15px] font-semibold tracking-tight">WGO</span></div>;
}
