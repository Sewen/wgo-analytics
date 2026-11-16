import type { Context } from 'aws-lambda';
import { reportCluster } from '../lib/cluster';
import { runRetention } from '../lib/retention';
import { runRollups } from '../lib/rollups';

/**
 * Scheduled every 15 minutes (one at a time): hourly rollups, hourly cluster metrics, daily retention.
 * Each step resumes where it stopped, so a run that hits its time budget simply continues next time.
 */
export async function handler(_event: unknown, context: Context): Promise<object> {
  const deadline = Date.now() + Math.min(context.getRemainingTimeInMillis() - 90_000, 12 * 60_000);
  const rollups = await runRollups(deadline);
  const cluster = await reportCluster().catch((err) => {
    console.warn('cluster metrics failed', err);
    return null;
  });
  // raw events are only deleted after they are rolled up; retention waits until rollups have caught up
  const retention = rollups.caughtUp ? await runRetention(deadline, rollups.until) : { done: false, deleted: {} };
  const result = { rollups, cluster, retention };
  console.log(JSON.stringify(result));
  return result;
}
