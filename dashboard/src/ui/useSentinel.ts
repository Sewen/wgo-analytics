import { useEffect, useRef } from 'react';
export function useSentinel(onVisible: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisible); cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) cb.current(); }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}
