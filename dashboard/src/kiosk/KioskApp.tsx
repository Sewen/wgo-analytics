import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorX, WifiOff } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { KioskPage, KioskState, Project, Watch } from '../api/contract';
import { KIOSK_TOKEN, normParams } from '../lib/kiosk';
import { PAGES, ProjectCtx } from '../lib/project';
import { navigate, useRoute } from '../lib/router';
import { resolveRange, TimeCtx } from '../lib/time';
import { cn } from '../lib/format';
import { LiveProvider } from '../live/LiveProvider';
import { LiveCtx } from '../live/store';
import { LogoMark } from '../ui/Logo';
import { ToastProvider } from '../ui/kit';
import { Overview } from '../pages/Overview';
import { LivePage } from '../pages/LivePage';
import { ClicksPage } from '../pages/Clicks';
import { ErrorsPage } from '../pages/Errors';
import { NetworkPage } from '../pages/Network';
import { EventsPage } from '../pages/Events';
import { TracesPage } from '../pages/Traces';
import { LogsPage } from '../pages/Logs';
import { MetricsPage } from '../pages/Metrics';

/**
 * The dashboard as a wall display, at #/kiosk/<token>. No sign-in: the token in the URL authenticates every
 * request (api/client.ts) and the live WebSocket (live/store.ts). The screen polls its configuration, so
 * project members change what it shows from the dashboard; a change starts the rotation over right away.
 *
 * Built to run unattended for months on a Raspberry Pi: it keeps showing the last data while offline, keeps the
 * display awake, hides the cursor, scrolls pages taller than the screen, and reloads itself now and then (only
 * when the dashboard is reachable, so Chromium never ends up on its offline error page).
 */
const POLL_MS = 15_000;
const RELOAD_EVERY_MS = 12 * 3600e3; // pick up new dashboard builds, release memory
const RELOAD_RETRY_MS = 5 * 60e3;

const PAGE: Record<KioskPage, () => React.ReactNode> = {
  overview: () => <Overview />,
  live: () => <LivePage />,
  clicks: () => <ClicksPage />,
  errors: () => <ErrorsPage />,
  network: () => <NetworkPage />,
  events: () => <EventsPage />,
  traces: () => <TracesPage traceId={null} />,
  logs: () => <LogsPage />,
  metrics: () => <MetricsPage />,
};
const pageLabel = (p: KioskPage) => PAGES.find((x) => x.id === p)?.label ?? p;

/** Reload only if the dashboard answers: reloading while offline would leave Chromium on its error page for good. */
async function safeReload(): Promise<boolean> {
  try {
    const res = await fetch(window.location.pathname, { cache: 'no-store' });
    if (!res.ok) return false;
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

const is401 = (e: unknown) => e instanceof ApiError && e.status === 401;

export function KioskApp() {
  const state = useQuery({
    queryKey: ['kiosk-state'],
    queryFn: () => api<KioskState>('/kiosk/v1/state', {
      params: { w: Math.round(window.innerWidth * devicePixelRatio), h: Math.round(window.innerHeight * devicePixelRatio) },
    }),
    refetchInterval: (q) => (is401(q.state.error) ? 60_000 : POLL_MS),
    refetchIntervalInBackground: true,
    retry: (n, e) => !is401(e) && n < 2,
    staleTime: 0,
  });
  useKeepAlive();

  // "Reload screen" in the dashboard bumps reloadAt
  const bootReloadAt = useRef<string | null | undefined>(undefined);
  const reloadAt = state.data?.reloadAt;
  useEffect(() => {
    if (reloadAt === undefined) return;
    if (bootReloadAt.current === undefined) bootReloadAt.current = reloadAt;
    else if (reloadAt !== bootReloadAt.current) void safeReload();
  }, [reloadAt, state.dataUpdatedAt]);

  useEffect(() => {
    if (state.data) document.title = `${state.data.kiosk.name} · WGO`;
    if (state.data) document.documentElement.dataset.theme = state.data.config.theme;
  }, [state.data]);

  if (!KIOSK_TOKEN || is401(state.error)) {
    return <Notice icon={<MonitorX size={28} />} title="This kiosk link no longer works">
      It was removed or replaced in WGO. Open <b>Kiosks</b> in the dashboard and set up this screen again with the current link.
    </Notice>;
  }
  if (!state.data) {
    return <Notice title={state.isError ? 'Can’t reach WGO yet' : 'Connecting to WGO…'} pulse>
      {state.isError ? 'Retrying every few seconds. Check the network if this doesn’t go away.' : 'Loading what to show.'}
    </Notice>;
  }
  return <ToastProvider><Screens st={state.data} offline={state.isError} /></ToastProvider>;
}

function Screens({ st, offline }: { st: KioskState; offline: boolean }) {
  const qc = useQueryClient();
  const { config, project } = st;
  const { screens } = config;

  // rotation; a change from the dashboard starts over at the first screen, so it shows up at once
  const [idx, setIdx] = useState(0);
  const [seenVersion, setSeenVersion] = useState(st.version);
  if (st.version !== seenVersion) { setSeenVersion(st.version); setIdx(0); }
  const i = idx % screens.length;
  const scr = screens[i];
  useEffect(() => {
    if (screens.length < 2) return;
    const t = setTimeout(() => setIdx((x) => (x + 1) % screens.length), config.rotateSeconds * 1000);
    return () => clearTimeout(t);
  }, [i, st.version, screens.length, config.rotateSeconds]);

  // pages read their range, filters and options from the hash, exactly as in the dashboard
  const want = normParams(scr.params);
  const route = useRoute();
  const atScreen = route.segments[0] === 'kiosk' && route.segments[1] === KIOSK_TOKEN && route.segments.length === 2 && route.params.toString() === want;
  useLayoutEffect(() => {
    if (!atScreen) navigate(`/kiosk/${KIOSK_TOKEN}${want ? `?${want}` : ''}`, true); // also undoes taps that navigate away
  }, [atScreen, want]);

  // data refresh: a new `now` moves the time range, which re-queries; screens share it between rotations
  const refreshMs = config.refreshSeconds * 1000;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), refreshMs); return () => clearInterval(t); }, [refreshMs]);
  const paramsKey = route.params.toString();
  const range = useMemo(() => resolveRange(route.params, now), [paramsKey, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const timeCtx = useMemo(() => ({ range, refresh: () => { setNow(Date.now()); void qc.invalidateQueries(); }, auto: true, setAuto: () => {} }), [range, qc]);
  const projectCtx = useMemo(() => ({
    // a kiosk only knows the project's id and name; pages don't need more
    project: { id: project.id, name: project.name, role: 'member', writeKey: '', createdAt: '' } as unknown as Project,
    projects: [], email: '',
  }), [project.id, project.name]);

  // zoom for screens read from across the room: a wrapper scaled up to fill the window
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const h = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', h); return () => window.removeEventListener('resize', h);
  }, []);
  const zoom = config.zoom || 1;

  const scrollRef = useRef<HTMLElement>(null);
  const screenKey = `${i}:${st.version}`;
  useAutoScroll(scrollRef, screenKey);
  const idle = useIdleCursor();

  return (
    <ProjectCtx.Provider value={projectCtx}>
      <TimeCtx.Provider value={timeCtx}>
        <LiveProvider pid={project.id}>
          <KioskWatches watches={scr.page === 'live' ? scr.watches ?? [] : []} />
          <div className={cn('bg-atmos flex flex-col overflow-hidden', idle && 'cursor-none [&_*]:cursor-none')} style={{ zoom, width: vp.w / zoom, height: vp.h / zoom }}>
            <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-[color-mix(in_srgb,var(--bg)_70%,transparent)] px-6 backdrop-blur-xl">
              <LogoMark size={28} />
              <div className="min-w-0">
                <div className="truncate text-[17px] font-semibold leading-tight tracking-tight">{scr.title || pageLabel(scr.page)}</div>
                <div className="truncate text-[12px] text-muted">{project.name} · {range.preset === 'custom' ? 'Fixed dates' : range.label}</div>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-5">
                {offline && <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-3 py-1 text-[12px] font-medium text-warn"><WifiOff size={13} />Offline · showing the last data</span>}
                {screens.length > 1 && (
                  <div className="flex items-center gap-1.5" aria-label={`Screen ${i + 1} of ${screens.length}`}>
                    {screens.map((_, j) => <i key={j} className={cn('h-1.5 rounded-full transition-all duration-300', j === i ? 'w-5 bg-accent' : 'w-1.5 bg-[var(--line-strong)]')} />)}
                  </div>
                )}
                <Clock />
              </div>
            </header>
            {screens.length > 1 && (
              <div className="h-[2px] shrink-0 bg-[var(--line)]">
                <div key={screenKey} className="h-full origin-left grad-bg" style={{ animation: `kiosk-progress ${config.rotateSeconds}s linear forwards` }} />
              </div>
            )}
            <main ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
              {atScreen && <div key={screenKey} className="page-in p-5">{PAGE[scr.page]()}</div>}
            </main>
          </div>
          <style>{'@keyframes kiosk-progress { from { transform: scaleX(0) } to { transform: scaleX(1) } }'}</style>
        </LiveProvider>
      </TimeCtx.Provider>
    </ProjectCtx.Provider>
  );
}

/** The live screen counts the watches saved with it. */
function KioskWatches({ watches }: { watches: Watch[] }) {
  const store = useContext(LiveCtx);
  const key = JSON.stringify(watches);
  useEffect(() => { store.setWatches(watches); }, [store, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function Clock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const i = setInterval(() => setT(new Date()), 5_000); return () => clearInterval(i); }, []);
  return <span className="tnum text-[20px] font-semibold tracking-tight">{t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>;
}

function Notice({ icon, title, children, pulse }: { icon?: React.ReactNode; title: string; children: React.ReactNode; pulse?: boolean }) {
  return (
    <div className="bg-atmos grid h-full place-items-center p-8 cursor-none">
      <div className="max-w-[560px] text-center">
        <div className={cn('mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-[var(--hl)] text-muted', pulse && 'pulse-dot')}>{icon ?? <LogoMark size={40} />}</div>
        <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-[15px] text-muted">{children}</p>
      </div>
    </div>
  );
}

/**
 * Pages taller than the screen scroll by themselves: pause at the top, glide down, pause, back to the top.
 * A TV has nobody to scroll it.
 */
function useAutoScroll(ref: RefObject<HTMLElement | null>, key: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = 0;
    const PAUSE_MS = 8000, SPEED = 30; // CSS px per second
    let phase: 'top' | 'down' | 'bottom' = 'top', since = performance.now(), last = since, pos = 0, raf = 0;
    const step = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 8) { phase = 'top'; since = t; pos = 0; }
      else if (phase === 'top' && t - since > PAUSE_MS) phase = 'down';
      else if (phase === 'down') {
        pos = Math.min(max, pos + SPEED * dt);
        el.scrollTop = pos;
        if (pos >= max) { phase = 'bottom'; since = t; }
      } else if (phase === 'bottom' && t - since > PAUSE_MS) {
        el.scrollTo({ top: 0, behavior: 'smooth' });
        phase = 'top'; since = t; pos = 0;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [ref, key]);
}

/** Hide the pointer unless someone moves the mouse. */
function useIdleCursor(): boolean {
  const [idle, setIdle] = useState(true);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const move = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 3000); };
    window.addEventListener('pointermove', move);
    return () => { window.removeEventListener('pointermove', move); clearTimeout(t); };
  }, []);
  return idle;
}

/** Keep the display awake, and reload now and then to pick up new dashboard builds and start fresh. */
function useKeepAlive() {
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    const acquire = () => { if (wl && document.visibilityState === 'visible') wl.request('screen').then((l) => { lock = l; }, () => {}); };
    acquire();
    document.addEventListener('visibilitychange', acquire); // the lock is dropped whenever the page is hidden

    let timer: ReturnType<typeof setTimeout>;
    const reload = async () => { if (!(await safeReload())) timer = setTimeout(reload, RELOAD_RETRY_MS); };
    timer = setTimeout(reload, RELOAD_EVERY_MS);
    return () => { document.removeEventListener('visibilitychange', acquire); void lock?.release(); clearTimeout(timer); };
  }, []);
}
