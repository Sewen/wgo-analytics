import type { Context } from 'aws-lambda';
import { reportCluster } from '../lib/cluster';
import { runRetention } from '../lib/retention';
import { runRollups } from '../lib/rollups';
import { moveLegacyRows, runCompaction } from '../lib/store/maintain';

/**
 * Scheduled every 15 minutes (one at a time): moving raw rows left in DSQL by older versions into Parquet
 * (until there are none), merging small Parquet files, hourly rollups, hourly cluster metrics, daily retention.
 * Each step resumes where it stopped, so a run that hits its time budget simply continues next time.
 */
export async function handler(_event: unknown, context: Context): Promise<object> {
  const deadline = Date.now() + Math.min(context.getRemainingTimeInMillis() - 90_000, 12 * 60_000);
  const legacy = await moveLegacyRows(deadline);
  // merging gets a share of the run, so rollups and retention always get time too
  const compaction = await runCompaction(Math.min(deadline, Date.now() + 4 * 60_000));
  const rollups = await runRollups(deadline);
  const cluster = await reportCluster().catch((err) => {
    console.warn('cluster metrics failed', err);
    return null;
  });
  // raw events are only deleted after they are rolled up; retention waits until rollups have caught up
  const retention = rollups.caughtUp ? await runRetention(deadline, rollups.until) : { done: false, deleted: {} };
  const result = { legacy, compaction, rollups, cluster, retention };
  console.log(JSON.stringify(result));
  return result;
}
