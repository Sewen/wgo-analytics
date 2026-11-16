import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { deleteConnection, putConnection, send, setSubscription } from '../lib/live';
import { sanitizeWatches } from '../lib/match';
import { emailAllowed } from '../lib/allowlist';
import { getProject } from '../lib/projects';
import { authenticateKiosk } from '../lib/kiosks';

type WsEvent = APIGatewayProxyWebsocketEventV2 & { queryStringParameters?: Record<string, string> };

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  clientId: process.env.USER_POOL_CLIENT_ID!,
  tokenUse: 'id',
});

const ok: APIGatewayProxyResultV2 = { statusCode: 200, body: '' };

/** One function for $connect, $disconnect and $default (subscribe / ping). */
export async function handler(event: WsEvent): Promise<APIGatewayProxyResultV2> {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  try {
    if (routeKey === '$connect') {
      const { token, projectId, kiosk } = event.queryStringParameters ?? {};
      // kiosk screens connect with their kiosk token, which pins the project
      if (kiosk) {
        const k = await authenticateKiosk(kiosk).catch(() => null);
        if (!k) return { statusCode: 401, body: 'invalid kiosk token' };
        await putConnection(connectionId, k.projectId, `kiosk:${k.id}`);
        return ok;
      }
      if (!token || !projectId) return { statusCode: 401, body: 'token and projectId required' };
      let email: string;
      try {
        const claims = await verifier.verify(token);
        email = String(claims.email ?? '').toLowerCase();
      } catch {
        return { statusCode: 401, body: 'invalid token' };
      }
      if (!emailAllowed(email)) return { statusCode: 403, body: 'email domain not allowed' };
      try {
        await getProject(email, projectId);
      } catch {
        return { statusCode: 403, body: 'no access to project' };
      }
      await putConnection(connectionId, projectId, email);
      return ok;
    }

    if (routeKey === '$disconnect') {
      await deleteConnection(connectionId);
      return ok;
    }

    let msg: { action?: string; watches?: unknown; firehose?: unknown } = {};
    try {
      msg = JSON.parse(event.body ?? '{}');
    } catch {
      /* ignore malformed frames */
    }
    if (msg.action === 'subscribe') {
      const watches = sanitizeWatches(msg.watches);
      const firehose = msg.firehose === true;
      await setSubscription(connectionId, watches, firehose);
      await send(connectionId, { type: 'subscribed', watches: watches.length, firehose }, endpoint);
    } else if (msg.action === 'ping') {
      await send(connectionId, { type: 'pong' }, endpoint);
    }
    return ok;
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'error' };
  }
}
