import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SlackIntegration, SlackSetup } from '../contract';
import { query } from './db';
import { HttpError } from './http';

/**
 * "Add to Slack" with the incoming-webhook scope: the user picks a workspace and channel on Slack's consent
 * screen and we get a webhook URL for that channel.
 *
 * Slack ties every "Add to Slack" button to a Slack app. A self-hosted WGO needs one app, created once:
 * either set up from the dashboard (stored per project, owners only) or for the whole instance with
 * SLACK_CLIENT_ID / SLACK_CLIENT_SECRET at deploy time.
 */
interface Creds { clientId: string; clientSecret: string; source: 'project' | 'instance' }

async function credentials(pid: string): Promise<Creds | null> {
  const [row] = await query<{ config: { clientId: string; clientSecret: string } }>(
    `SELECT config FROM integrations WHERE project_id = $1 AND type = 'slack_app' LIMIT 1`,
    [pid],
  );
  if (row) return { ...row.config, source: 'project' };
  const clientId = process.env.SLACK_CLIENT_ID ?? '';
  const clientSecret = process.env.SLACK_CLIENT_SECRET ?? '';
  return clientId && clientSecret ? { clientId, clientSecret, source: 'instance' } : null;
}

const redirectUrl = (apiDomain: string) => `https://${apiDomain}/slack/callback`;

/**
 * A pre-filled Slack app manifest: Slack's "create app" page asks only which workspace to create it in.
 * Slack rejects bot scopes (incoming-webhook counts as one) unless the manifest also declares a bot user.
 */
export function createAppUrl(apiDomain: string): string {
  const manifest = {
    display_information: { name: 'WGO', description: "Notifications from WGO (What's going on?) triggers", background_color: '#14141c' },
    features: { bot_user: { display_name: 'WGO', always_online: false } },
    oauth_config: { redirect_urls: [redirectUrl(apiDomain)], scopes: { bot: ['incoming-webhook'] } },
    settings: {
      incoming_webhooks: { incoming_webhooks_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export async function setupStatus(pid: string, apiDomain: string): Promise<SlackSetup> {
  const creds = await credentials(pid);
  return {
    configured: !!creds,
    source: creds?.source ?? null,
    clientId: creds?.source === 'project' ? creds.clientId : null,
    redirectUrl: redirectUrl(apiDomain),
    createAppUrl: createAppUrl(apiDomain),
  };
}

/**
 * Save the project's Slack app credentials after checking them with Slack: exchanging a dummy code fails with
 * `invalid_code` only once the client id and secret are valid.
 */
export async function saveApp(pid: string, email: string, clientId: unknown, clientSecret: unknown): Promise<void> {
  const id = typeof clientId === 'string' ? clientId.trim() : '';
  const secret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
  if (!/^\d+\.\d+$/.test(id)) throw new HttpError(400, 'That doesn’t look like a Slack Client ID (digits.digits, under Basic Information)');
  if (!/^[0-9a-f]{32}$/i.test(secret)) throw new HttpError(400, 'That doesn’t look like a Slack Client Secret (32 hex characters; click Show next to it)');
  const check = await oauthAccess(id, secret, 'wgo-credential-check', 'https://example.invalid/');
  if (check.error === 'invalid_client_id') throw new HttpError(400, 'Slack doesn’t know that Client ID');
  if (check.error === 'bad_client_secret') throw new HttpError(400, 'That Client Secret doesn’t match the Client ID');
  await query(`DELETE FROM integrations WHERE project_id = $1 AND type = 'slack_app'`, [pid]);
  await query(
    `INSERT INTO integrations (project_id, id, type, config, created_by) VALUES ($1, $2, 'slack_app', $3::jsonb, $4)`,
    [pid, randomUUID(), JSON.stringify({ clientId: id, clientSecret: secret }), email],
  );
}

export async function removeApp(pid: string): Promise<void> {
  await query(`DELETE FROM integrations WHERE project_id = $1 AND type = 'slack_app'`, [pid]);
}

// ---------------------------------------------------------------- OAuth

const STATE_TTL_MS = 15 * 60 * 1000;
const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

/** Signed, expiring state: ties the callback to the project and user that started the install. */
export function signState(secret: string, pid: string, email: string, returnTo: string | null, now = Date.now()): string {
  const data = Buffer.from(JSON.stringify({ p: pid, e: email, r: returnTo, x: now + STATE_TTL_MS })).toString('base64url');
  return `${data}.${mac(secret, data)}`;
}

/** The project id is read before verification only to find which app's secret signed the state. */
export function peekStateProject(state: string): string | null {
  try {
    return (JSON.parse(Buffer.from(state.split('.')[0] ?? '', 'base64url').toString()) as { p?: string }).p ?? null;
  } catch {
    return null;
  }
}

export function verifyState(secret: string, state: string, now = Date.now()): { pid: string; email: string; returnTo: string | null } {
  const [data, sig] = state.split('.');
  if (!data || !sig) throw new HttpError(400, 'Bad state');
  const expected = Buffer.from(mac(secret, data));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(400, 'Bad state signature');
  const { p, e, r, x } = JSON.parse(Buffer.from(data, 'base64url').toString()) as { p: string; e: string; r: string | null; x: number };
  if (now > x) throw new HttpError(400, 'Slack install link expired, try again');
  return { pid: p, email: e, returnTo: r ?? null };
}

/** Verify a callback's state against the credentials of the project it names. */
export async function verifyCallbackState(state: string): Promise<{ pid: string; email: string; returnTo: string | null }> {
  const pid = peekStateProject(state);
  const creds = pid ? await credentials(pid) : null;
  if (!creds) throw new HttpError(400, 'Bad state');
  return verifyState(creds.clientSecret, state);
}

export async function installUrl(pid: string, email: string, apiDomain: string, returnTo: string | null): Promise<string> {
  const creds = await credentials(pid);
  if (!creds) throw new HttpError(409, 'Set up the Slack app for this project first');
  const u = new URL('https://slack.com/oauth/v2/authorize');
  u.searchParams.set('client_id', creds.clientId);
  u.searchParams.set('scope', 'incoming-webhook');
  u.searchParams.set('redirect_uri', redirectUrl(apiDomain));
  u.searchParams.set('state', signState(creds.clientSecret, pid, email, returnTo));
  return u.toString();
}

interface OAuthAccess {
  ok: boolean;
  error?: string;
  team?: { name?: string };
  incoming_webhook?: { url: string; channel: string; channel_id: string; configuration_url?: string };
}

async function oauthAccess(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<OAuthAccess> {
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(8000),
  });
  return (await res.json()) as OAuthAccess;
}

/** Exchange the code for the channel's webhook URL and store it as an integration. Returns the project id. */
export async function completeInstall(code: string, state: string, apiDomain: string): Promise<string> {
  const { pid, email } = await verifyCallbackState(state);
  const creds = (await credentials(pid))!;
  const body = await oauthAccess(creds.clientId, creds.clientSecret, code, redirectUrl(apiDomain));
  if (!body.ok || !body.incoming_webhook?.url) throw new HttpError(502, `Slack: ${body.error ?? 'no webhook returned'}`);
  const hook = body.incoming_webhook;
  await query(
    'INSERT INTO integrations (project_id, id, type, config, created_by) VALUES ($1, $2, $3, $4::jsonb, $5)',
    [pid, randomUUID(), 'slack', JSON.stringify({ webhookUrl: hook.url, channel: hook.channel, channelId: hook.channel_id, configurationUrl: hook.configuration_url ?? null, teamName: body.team?.name ?? null }), email],
  );
  return pid;
}

// ---------------------------------------------------------------- connected channels

export async function listIntegrations(pid: string): Promise<SlackIntegration[]> {
  const rows = await query<{ id: string; config: { channel: string; teamName: string | null }; created_by: string; created_at: Date }>(
    `SELECT id, config, created_by, created_at FROM integrations WHERE project_id = $1 AND type = 'slack' ORDER BY created_at`,
    [pid],
  );
  // never expose the webhook URL itself: it's a credential for posting to the channel
  return rows.map((r) => ({ id: r.id, type: 'slack', channel: r.config.channel, teamName: r.config.teamName, createdBy: r.created_by, createdAt: r.created_at.toISOString() }));
}

export async function deleteIntegration(pid: string, id: string): Promise<void> {
  const used = await query<{ name: string }>(`SELECT name FROM triggers WHERE project_id = $1 AND destination->>'integrationId' = $2`, [pid, id]);
  if (used.length) throw new HttpError(409, `Still used by trigger${used.length > 1 ? 's' : ''}: ${used.map((u) => u.name).join(', ')}`);
  await query(`DELETE FROM integrations WHERE project_id = $1 AND id = $2 AND type = 'slack'`, [pid, id]);
}
