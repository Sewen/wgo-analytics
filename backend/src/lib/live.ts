import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AnalyticsEvent, LiveEvent, ServerMessage, Watch } from '../contract';
import { matchesWatch } from './match';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const TABLE = () => process.env.CONNECTIONS_TABLE!;

export interface ConnectionItem {
  connectionId: string;
  projectId: string;
  email: string;
  watches: Watch[];
  firehose: boolean;
  ttl: number;
}

const CONNECTION_TTL_S = 3 * 3600; // API Gateway caps WebSocket connections at 2h

export async function putConnection(connectionId: string, projectId: string, email: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE(),
      Item: { connectionId, projectId, email, watches: [], firehose: false, ttl: Math.floor(Date.now() / 1000) + CONNECTION_TTL_S },
    }),
  );
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { connectionId } }));
}

export async function setSubscription(connectionId: string, watches: Watch[], firehose: boolean): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { connectionId },
      UpdateExpression: 'SET watches = :w, firehose = :f',
      ConditionExpression: 'attribute_exists(connectionId)',
      ExpressionAttributeValues: { ':w': watches, ':f': firehose },
    }),
  );
}

async function subscribers(projectId: string): Promise<ConnectionItem[]> {
  const items: ConnectionItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE(),
        IndexName: 'ProjectIndex',
        KeyConditionExpression: 'projectId = :p',
        ExpressionAttributeValues: { ':p': projectId },
        ExclusiveStartKey,
      }),
    );
    items.push(...((res.Items ?? []) as ConnectionItem[]));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

let mgmt: ApiGatewayManagementApiClient | undefined;
function managementClient(endpoint = process.env.WS_MANAGEMENT_ENDPOINT): ApiGatewayManagementApiClient {
  if (endpoint !== process.env.WS_MANAGEMENT_ENDPOINT) return new ApiGatewayManagementApiClient({ endpoint });
  mgmt ??= new ApiGatewayManagementApiClient({ endpoint });
  return mgmt;
}

/** Send a message; stale connections are cleaned up. Returns false if the connection is gone. */
export async function send(connectionId: string, msg: ServerMessage, endpoint?: string): Promise<boolean> {
  try {
    await managementClient(endpoint).send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(msg)) }));
    return true;
  } catch (err) {
    if (err instanceof GoneException || (err as { name?: string }).name === 'GoneException') {
      await deleteConnection(connectionId).catch(() => {});
      return false;
    }
    throw err;
  }
}

// WebSocket frames are capped at 128 KB; stay well under.
const MAX_FRAME_BYTES = 100_000;

export function selectForConnection(conn: Pick<ConnectionItem, 'watches' | 'firehose'>, events: AnalyticsEvent[]): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const e of events) {
    const matches = (conn.watches ?? []).filter((w) => matchesWatch(w, e)).map((w) => w.id);
    if (matches.length || conn.firehose) out.push({ ...e, matches });
  }
  return out;
}

/** Push matching events of an ingested batch to every live dashboard of the project. */
export async function fanOut(projectId: string, events: AnalyticsEvent[]): Promise<void> {
  if (!events.length || !process.env.WS_MANAGEMENT_ENDPOINT) return; // no WebSocket API (local dev)
  const conns = await subscribers(projectId);
  if (!conns.length) return;
  // Stacks are large and not needed for the live view.
  const slim = events.map((e) => ({ ...e, errorStack: e.errorStack ? e.errorStack.slice(0, 500) : null }));
  await Promise.allSettled(
    conns.map(async (c) => {
      const selected = selectForConnection(c, slim);
      for (const chunk of chunkBySize(selected, MAX_FRAME_BYTES)) {
        if (!(await send(c.connectionId, { type: 'events', events: chunk }))) return;
      }
    }),
  );
}

export function chunkBySize<T>(items: T[], maxBytes: number): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const item of items) {
    const n = Buffer.byteLength(JSON.stringify(item));
    if (n > maxBytes) continue;
    if (size + n > maxBytes && cur.length) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(item);
    size += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
