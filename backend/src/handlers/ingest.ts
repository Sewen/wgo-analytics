import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { insertRows } from '../lib/db';
import { EVENT_COLUMNS, eventRowValues, normalizeBatch, toApiEvent, type WireBatch } from '../lib/events';
import { handleError, header, json, jsonBody } from '../lib/http';
import { storeErrorStacks } from '../lib/errorStacks';
import { geoFromHeaders } from '../lib/geo';
import { fanOut } from '../lib/live';
import { projectIdForWriteKey } from '../lib/projects';
import { evaluateTriggers } from '../lib/triggers';

/** POST /ingest — SDK batches. Write key travels in the body (sendBeacon can't set headers). */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const batch = jsonBody<WireBatch>(event);
    const projectId = await projectIdForWriteKey(batch.k ?? event.queryStringParameters?.k);
    if (!projectId) return json(401, { error: 'Unknown write key' });

    const rows = normalizeBatch(projectId, batch, Date.now(), header(event, 'user-agent'), geoFromHeaders(event.headers));
    if (!rows.length) return json(202, { accepted: 0 });

    // Live fan-out runs alongside the write: the dashboard should see a click as soon as we do.
    // A fan-out failure must never make the SDK retry (it would duplicate stored events).
    // bots are stored (flagged) but never light up live watches or fire triggers
    const apiEvents = rows.filter((r) => !r.bot).map(toApiEvent);
    const live = fanOut(projectId, apiEvents).catch((err) => console.warn('fan-out failed', err));
    // stacks are stored once per error group (before the events, so a visible error always has one)
    await storeErrorStacks(rows);
    await insertRows('events', EVENT_COLUMNS, rows.map((r) => eventRowValues({ ...r, error_stack: null })), { props: '::jsonb' });
    // triggers only after the write succeeded, so a retried batch can't notify twice for events we dropped
    await Promise.all([live, evaluateTriggers(projectId, apiEvents).catch((err) => console.warn('trigger evaluation failed', err))]);

    return json(202, { accepted: rows.length });
  } catch (err) {
    return handleError(err);
  }
}
