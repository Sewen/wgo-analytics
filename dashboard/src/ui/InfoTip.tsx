import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cn } from '../lib/format';

/**
 * A small ⓘ that explains a term on hover or keyboard focus. `align` keeps the bubble inside its container
 * (use "end" near a right edge).
 */
export function InfoTip({ children, label = 'What is this?', align = 'start', className }: {
  children: ReactNode; label?: string; align?: 'start' | 'end'; className?: string;
}) {
  return (
    <span className={cn('group relative inline-flex align-middle', className)}>
      <button type="button" aria-label={label} className="rounded-full text-faint transition-colors hover:text-fg focus:text-fg focus:outline-none cursor-help">
        <Info size={12} />
      </button>
      <span role="tooltip"
        className={cn(
          'pointer-events-none invisible absolute bottom-full z-40 mb-2 w-64 rounded-lg border border-[var(--line-strong)] bg-[var(--raised)] px-3 py-2',
          'text-left text-[12px] font-normal normal-case leading-relaxed tracking-normal text-muted opacity-0 shadow-xl transition-opacity duration-150',
          'group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100',
          align === 'end' ? 'right-0' : '-left-2',
        )}>
        {children}
      </span>
    </span>
  );
}
