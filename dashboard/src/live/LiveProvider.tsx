import { clickLabel } from '../lib/events';
import { useEffect, useMemo, type ReactNode } from 'react';
import { LiveCtx, LiveStore } from './store';
import { useToast } from '../ui/kit';

export const LIVE_PREFS = 'analytico.live.prefs';
export function readPrefs(): { toasts: boolean; notify: boolean } {
  try { return { toasts: false, notify: false, ...JSON.parse(localStorage.getItem(LIVE_PREFS) ?? '{}') }; } catch { return { toasts: false, notify: false }; }
}

export function LiveProvider({ pid, children }: { pid: string; children: ReactNode }) {
  const toast = useToast();
  const store = useMemo(() => new LiveStore(pid), [pid]);
  useEffect(() => {
    store.onFire = (w, e) => {
      const p = readPrefs();
      const detail = e.type === 'click' ? clickLabel(e) : e.elementText || e.path || e.name || '';
      if (p.toasts) toast({ title: `${w.label} fired`, body: detail, tone: 'accent' });
      if (p.notify && 'Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(`${w.label} fired`, { body: detail });
    };
    store.start();
    return () => { store.onFire = null; store.stop(); };
  }, [store, toast]);
  return <LiveCtx.Provider value={store}>{children}</LiveCtx.Provider>;
}
