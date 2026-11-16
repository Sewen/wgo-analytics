import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { completeInstall, verifyCallbackState } from '../lib/slack';

/** GET /slack/callback: Slack redirects here after the user picked a workspace and channel; back to the dashboard. */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {};
  let pid: string, dashboard: string;
  try {
    const st = await verifyCallbackState(q.state ?? '');
    pid = st.pid;
    dashboard = st.returnTo ?? '';
  } catch {
    return { statusCode: 400, headers: { 'content-type': 'text/plain' }, body: 'This Slack link is invalid or expired. Start again from WGO.' };
  }
  const back = (result: string) => ({
    statusCode: 302,
    headers: { location: `${dashboard}/#/p/${pid}/triggers?slack=${encodeURIComponent(result)}` },
    body: '',
  });
  if (q.error || !q.code) return back(q.error === 'access_denied' ? 'cancelled' : 'error'); // user clicked Cancel
  try {
    await completeInstall(q.code, q.state!, event.requestContext.domainName);
    return back('connected');
  } catch (err) {
    console.error('slack install failed', err);
    return back('error');
  }
}
