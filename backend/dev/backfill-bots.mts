/**
 * Flag bot traffic in events stored before bot detection existed, then rebuild the hourly rollups those
 * events fed. Uses what every event already carries: browser (from the user agent), the browser's time zone
 * and the automation flag (props.$ctx), and the country CloudFront located.
 *
 * Dry run (default) only reports. --apply writes.
 *   AWS_PROFILE=… AWS_REGION=… DSQL_ENDPOINT=… npx tsx dev/backfill-bots.mts [--days 30] [--apply]
 */
import { parseArgs } from 'node:util';
import { botReason } from '../src/lib/bots';
import { closeDb, query } from '../src/lib/db';
import { HOUR, floorHour, rollupHour } from '../src/lib/rollups';

const { values } = parseArgs({ options: { days: { type: 'string', default: '30' }, apply: { type: 'boolean', default: false } } });
const since = new Date(Date.now() - Number(values.days) * 86_400_000);
const PAGE = 2000;
const UPDATE_CHUNK = 500; // DSQL: ≤ 3,000 rows per transaction

const projects = await query<{ id: string; name: string }>('SELECT id, name FROM projects ORDER BY created_at');
for (const p of projects) {
  const flagged = new Map<string, string[]>(); // reason → ids
  const hours = new Set<number>();
  let scanned = 0;
  let cursor = since;
  let lastId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await query<{ id: string; ts: Date; browser: string | null; tz: string | null; wd: string | null; country: string | null }>(
      `SELECT id, ts, browser, props->'$ctx'->>'tz' AS tz, props->'$ctx'->>'wd' AS wd, country
         FROM events WHERE project_id = $1 AND bot IS NULL AND (ts > $2 OR (ts = $2 AND id > $3))
        ORDER BY ts, id LIMIT ${PAGE}`,
      [p.id, cursor, lastId],
    );
    if (!rows.length) break;
    scanned += rows.length;
    for (const r of rows) {
      const reason = botReason({ uaIsBot: r.browser === 'Bot', webdriver: r.wd === 'true', tz: r.tz, country: r.country, at: r.ts });
      if (!reason) continue;
      (flagged.get(reason) ?? flagged.set(reason, []).get(reason)!).push(r.id);
      hours.add(floorHour(r.ts.getTime()));
    }
    cursor = rows[rows.length - 1].ts;
    lastId = rows[rows.length - 1].id;
  }
  const total = [...flagged.values()].reduce((a, ids) => a + ids.length, 0);
  console.log(`${p.name}: scanned ${scanned} events since ${since.toISOString().slice(0, 10)}, ${total} look like bots`,
    Object.fromEntries([...flagged].map(([r, ids]) => [r, ids.length])), `, ${hours.size} hourly rollups affected`);
  if (!values.apply || !total) continue;

  for (const [reason, ids] of flagged) {
    for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
      await query(`UPDATE events SET bot = $3 WHERE project_id = $1 AND ts >= $2 AND id = ANY($4::uuid[]) AND bot IS NULL`,
        [p.id, since, reason, ids.slice(i, i + UPDATE_CHUNK)]);
    }
  }
  // rebuild from scratch: an upsert alone would leave keys that only bots produced
  for (const h of [...hours].sort()) {
    await query('DELETE FROM rollups WHERE project_id = $1 AND hour = $2', [p.id, new Date(h)]);
    await query('DELETE FROM rollup_sketches WHERE project_id = $1 AND hour = $2', [p.id, new Date(h)]);
    if (h + HOUR <= Date.now()) await rollupHour(p.id, h);
  }
  console.log(`  ${p.name}: flagged ${total} events, rebuilt ${hours.size} hourly rollups`);
}
if (!values.apply) console.log('\nDry run: nothing was changed. Re-run with --apply to flag them.');
await closeDb();
