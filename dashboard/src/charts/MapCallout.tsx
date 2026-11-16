import type { AnalyticsEvent } from '../api/contract';
import { eventTitle } from '../lib/events';
import { relTime } from '../lib/format';
import { TYPE_COLOR } from '../ui/kit';

/** Small card anchored above a map dot listing its latest events. */
export function MapCallout({ title, events, now, empty, compact }: { title: string; events: AnalyticsEvent[]; now: number; empty?: string; compact?: boolean }) {
  return (
    <div className={compact ? 'geo-callout geo-callout-compact' : 'geo-callout'}>
      <div className="geo-callout-title">{title}</div>
      {events.length === 0 && <div className="geo-callout-empty">{empty ?? 'No recent events'}</div>}
      {events.map((e) => (
        <div key={e.id} className="geo-callout-row">
          <i style={{ background: TYPE_COLOR[e.type] }} title={e.type} />
          <span className="geo-callout-text">{eventTitle(e) || e.type}</span>
          <span className="geo-callout-time">{relTime(Date.parse(e.ts), now)}</span>
        </div>
      ))}
    </div>
  );
}
