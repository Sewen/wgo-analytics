import { randomUUID } from 'node:crypto';
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand, type Dimension } from '@aws-sdk/client-cloudwatch';
import { insertRows } from './db';
import { EVENT_COLUMNS, eventRowValues, toApiEvent, type EventRow } from './events';
import { getJobState, setJobState } from './jobState';
import { METRIC_COLUMNS, type MetricRow } from './otlp/normalize';
import { evaluateTriggers } from './triggers';

/**
 * Cluster health, hourly, into the project named by the stack's ClusterMetricsProjectId:
 * - metric points `wgo.dsql.storage_bytes` and `wgo.dsql.dpu` (chart them on the Metrics page or the widget),
 * - a custom event `wgo.cluster` with the same numbers in its props, run through the triggers like any
 *   ingested event, so "name = wgo.cluster AND props.storageGb > 5" can notify Slack or a webhook.
 * Aurora DSQL publishes TotalDPU and ClusterStorageSize to CloudWatch (AWS/AuroraDSQL).
 */
const NAMESPACE = 'AWS/AuroraDSQL';
const HOUR = 3600_000;

let cw: CloudWatchClient | undefined;

/** The metric's dimensions for this cluster (looked up, since the dimension name isn't fixed in the docs). */
async function dimensionsFor(metric: string, clusterId: string): Promise<Dimension[] | null> {
  cw ??= new CloudWatchClient({});
  const res = await cw.send(new ListMetricsCommand({ Namespace: NAMESPACE, MetricName: metric }));
  const m = res.Metrics?.find((x) => x.Dimensions?.length === 1 && x.Dimensions[0].Value === clusterId);
  return m?.Dimensions ?? null;
}

export interface ClusterStats {
  storageBytes: number | null;
  dpuLastHour: number | null;
  dpuLast24h: number | null;
}

export async function readClusterStats(clusterId: string, now = Date.now()): Promise<ClusterStats> {
  const [storageDims, dpuDims] = await Promise.all([dimensionsFor('ClusterStorageSize', clusterId), dimensionsFor('TotalDPU', clusterId)]);
  const queries = [];
  if (storageDims) queries.push({ Id: 'storage', MetricStat: { Metric: { Namespace: NAMESPACE, MetricName: 'ClusterStorageSize', Dimensions: storageDims }, Period: 3600, Stat: 'Maximum' } });
  if (dpuDims) queries.push({ Id: 'dpu', MetricStat: { Metric: { Namespace: NAMESPACE, MetricName: 'TotalDPU', Dimensions: dpuDims }, Period: 3600, Stat: 'Sum' } });
  if (!queries.length) return { storageBytes: null, dpuLastHour: null, dpuLast24h: null };
  const end = Math.floor(now / HOUR) * HOUR;
  const res = await cw!.send(new GetMetricDataCommand({
    StartTime: new Date(end - 24 * HOUR), EndTime: new Date(end), ScanBy: 'TimestampDescending', MetricDataQueries: queries,
  }));
  const values = (id: string) => res.MetricDataResults?.find((r) => r.Id === id)?.Values ?? null;
  const storage = values('storage');
  const dpu = values('dpu');
  return {
    storageBytes: storage?.length ? storage[0] : null,
    dpuLastHour: dpu?.length ? dpu[0] : dpu ? 0 : null,
    dpuLast24h: dpu ? dpu.reduce((a, b) => a + b, 0) : null,
  };
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Hourly: read the cluster's numbers and record them in the ops project. No-op unless configured. */
export async function reportCluster(now = Date.now(), read = readClusterStats): Promise<ClusterStats | null> {
  const pid = process.env.CLUSTER_METRICS_PROJECT_ID;
  const clusterId = process.env.DSQL_CLUSTER_ID;
  if (!pid || !clusterId) return null;
  const last = await getJobState('cluster');
  if (last && now - last.getTime() < 55 * 60_000) return null;

  const stats = await read(clusterId, now);
  const ts = new Date(now);
  const metric = (name: string, type: MetricRow['type'], unit: string, description: string, value: number): MetricRow => ({
    project_id: pid, ts, id: randomUUID(), name, type, unit, description, service: 'wgo', value, count: null, attributes: { cluster: clusterId },
  });
  const points: MetricRow[] = [];
  if (stats.storageBytes !== null) points.push(metric('wgo.dsql.storage_bytes', 'gauge', 'By', 'Aurora DSQL cluster storage size', stats.storageBytes));
  if (stats.dpuLastHour !== null) points.push(metric('wgo.dsql.dpu', 'sum', '{dpu}', 'Aurora DSQL DPUs used in the last hour', stats.dpuLastHour));
  if (points.length) await insertRows('metric_points', METRIC_COLUMNS, points.map((p) => METRIC_COLUMNS.map((c) => (c === 'attributes' ? JSON.stringify(p.attributes) : p[c]))), { attributes: '::jsonb' });

  const props: Record<string, unknown> = { clusterId };
  if (stats.storageBytes !== null) {
    props.storageBytes = Math.round(stats.storageBytes);
    props.storageGb = round(stats.storageBytes / 1e9, 3);
  }
  if (stats.dpuLastHour !== null) props.dpuLastHour = Math.round(stats.dpuLastHour);
  if (stats.dpuLast24h !== null) props.dpuLast24h = Math.round(stats.dpuLast24h);
  const row: EventRow = {
    project_id: pid, ts, id: randomUUID(), type: 'custom', session_id: null, anon_id: null, user_id: null, url: null, path: null,
    title: null, referrer: null, selector: null, element_text: null, element_tag: null, track_name: null, error_message: null,
    error_stack: null, error_source: null, fingerprint: null, http_method: null, http_url: null, http_route: null, http_status: null,
    duration_ms: null, name: 'wgo.cluster', props, browser: null, os: null, device: null, country: null, region: null, city: null,
    lat: null, lon: null, bot: null,
  };
  await insertRows('events', EVENT_COLUMNS, [eventRowValues(row)], { props: '::jsonb' });
  await evaluateTriggers(pid, [toApiEvent(row)]).catch((err) => console.warn('trigger evaluation failed', err));
  await setJobState('cluster', ts);
  return stats;
}
