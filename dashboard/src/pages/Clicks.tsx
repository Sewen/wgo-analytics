import { useMemo, useState } from 'react';
import { clickLabel, shortSelector } from '../lib/events';
import { Eye, MousePointerClick, Search, Siren } from 'lucide-react';
import { useClicks } from '../api/hooks';
import { useProject } from '../lib/project';
import { useTime } from '../lib/time';
import { useLive } from '../live/store';
import { navigate, pageHref, useRoute } from '../lib/router';
import { Badge, Button, Card, EmptyState, ErrorState, Mono, useToast } from '../ui/kit';
import { RowsSkeleton, TableHead } from './common';
import { fmtNum, relTime } from '../lib/format';

import { FilterBar } from '../ui/FilterBar';
import { RowActions } from '../ui/RowActions';
import { clickConditions } from '../lib/rowFilters';
const COLS = 'grid-cols-[minmax(160px,1.3fr)_minmax(90px,.7fr)_minmax(180px,1.5fr)_minmax(150px,1.2fr)_70px_80px_80px_160px]';

export function ClicksPage() {
  const { project } = useProject(); const { range } = useTime(); const route = useRoute();
  const live = useLive(); const toast = useToast();
  const { data, isPending, isError, error, refetch } = useClicks(project.id, range);
  const [q, setQ] = useState('');
  const rows = useMemo(() => (data ?? []).filter((r) => !q || (r.selector + (r.elementText ?? '') + (r.trackName ?? '')).toLowerCase().includes(q.toLowerCase())), [data, q]);
  const max = Math.max(1, ...rows.map((r) => r.count));
  const watch = (r: NonNullable<typeof data>[number]) => {
    const label = clickLabel(r);
    live.addWatch({ label, type: 'click', selector: r.selector, ...(r.trackName ? { name: r.trackName } : {}) });
    toast({ title: 'Watch created', body: label, tone: 'good' });
    navigate(pageHref(project.id, 'live', route.params));
  };
  if (isError) return <ErrorState error={error} retry={() => refetch()} />;
  return (
    <div className="space-y-4">
      <FilterBar scope="events" />
      <div className="flex items-center justify-between">
        <div className="relative w-72"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" /><input className="field !pl-8" placeholder="Filter by text, name or selector" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span className="text-[12.5px] text-muted tnum">{data ? `${fmtNum(data.reduce((a, r) => a + r.count, 0))} clicks · ${data.length} elements` : ''}</span>
      </div>
      <Card className="overflow-x-auto">
        <div className="min-w-[960px]">
          <TableHead className={COLS} cols={['Element', 'Track name', 'Selector', ['Clicks', ''], ['Sessions', 'text-right'], ['Rage', 'text-right'], ['Last seen', 'text-right'], '']} />
          {isPending ? <RowsSkeleton /> : rows.length === 0 ? (
            <EmptyState icon={<MousePointerClick size={22} />} title={q ? 'No clicks match' : 'No clicks recorded'} action={!q && <Button variant="primary" onClick={() => navigate(pageHref(project.id, 'settings', route.params))}>Install the snippet</Button>}>Clicks are captured automatically once the SDK is on your site.</EmptyState>
          ) : rows.map((r) => (
            <div key={r.selector} className={`group grid ${COLS} items-center gap-4 border-b border-line/60 px-4 py-2.5 text-[13px] transition-colors hover:bg-[var(--hl)]`}>
              <div className="min-w-0"><div className="truncate font-medium" title={r.elementText ?? undefined}>{r.elementText || <span className="font-mono text-[12px] text-muted">{shortSelector(r.selector)}</span>}</div>{r.elementTag && <div className="text-[11px] text-faint">&lt;{r.elementTag}&gt;</div>}</div>
              <div>{r.trackName ? <Badge tone="accent">{r.trackName}</Badge> : <span className="text-faint">–</span>}</div>
              <Mono className="truncate text-muted" title={r.selector}>{r.selector}</Mono>
              <div className="flex items-center gap-2.5"><span className="w-12 tnum font-medium">{fmtNum(r.count)}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--hl)]"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${(r.count / max) * 100}%`, background: 'var(--s3)' }} /></div></div>
              <div className="text-right tnum text-muted">{fmtNum(r.sessions)}</div>
              <div className="text-right">{r.rageClicks > 0 ? <Badge tone="bad"><Siren size={11} />{r.rageClicks}</Badge> : <span className="text-faint">–</span>}</div>
              <div className="text-right text-[12px] text-faint">{relTime(r.lastSeen)}</div>
              <div className="flex items-center justify-end gap-1"><RowActions scope="events" conditions={clickConditions(r)} /><Button size="sm" className="opacity-60 group-hover:opacity-100" onClick={() => watch(r)}><Eye size={13} />Watch live</Button></div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
