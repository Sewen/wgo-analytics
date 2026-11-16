import { getConfig } from './config';
import { getIdToken, refreshTokens, signOut } from '../auth/cognito';
import { KIOSK_TOKEN } from '../lib/kiosk';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Params = Record<string, string | number | boolean | null | undefined>;

/**
 * A kiosk screen has no Cognito session: it calls the kiosk API with the token from its URL. The project's read
 * routes keep their paths after the project id, so /api/projects/{pid}/stats becomes /kiosk/v1/stats and every
 * page works unchanged.
 */
function kioskPath(path: string): string {
  if (path.startsWith('/kiosk/')) return path;
  const m = path.match(/^\/api\/projects\/[^/]+\/(.+)$/);
  if (!m) throw new ApiError(403, 'Not available on a kiosk screen');
  return `/kiosk/v1/${m[1]}`;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; params?: Params; signal?: AbortSignal } = {}): Promise<T> {
  const url = new URL(getConfig().apiUrl + (KIOSK_TOKEN ? kioskPath(path) : path), window.location.origin);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined && v !== null && v !== '' && v !== false) url.searchParams.set(k, v === true ? '1' : String(v));
  }
  const doFetch = async () => {
    const token = KIOSK_TOKEN ?? (await getIdToken());
    return fetch(url, {
      method: opts.method ?? 'GET',
      signal: opts.signal,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  };
  let res = await doFetch();
  if (!KIOSK_TOKEN) {
    // refreshTokens() ends the session itself when Cognito rejects the refresh token; a failed refresh for any
    // other reason (network, throttling) keeps it. Only a 401 with freshly refreshed tokens means signing out.
    if (res.status === 401 && (await refreshTokens())) {
      res = await doFetch();
      if (res.status === 401) void signOut();
    }
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.message ?? j.error ?? msg; } catch { /* ignore */ }
    throw new ApiError(res.status, msg || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}
