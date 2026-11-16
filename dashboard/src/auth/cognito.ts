import { useSyncExternalStore } from 'react';
import { getConfig } from '../api/config';

export class AuthError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const FRIENDLY: Record<string, string> = {
  NotAuthorizedException: 'Incorrect email or password.',
  UserNotFoundException: 'Incorrect email or password.',
  UsernameExistsException: 'An account with this email already exists. Try signing in.',
  CodeMismatchException: 'That code is not correct. Check the email and try again.',
  ExpiredCodeException: 'That code has expired. We can send you a new one.',
  InvalidPasswordException: 'Password must be 8+ characters with upper, lower case and a number.',
  LimitExceededException: 'Too many attempts. Please wait a moment and try again.',
  TooManyRequestsException: 'Too many requests. Please wait a moment and try again.',
  TooManyFailedAttemptsException: 'Too many failed attempts. Please wait a while.',
  InvalidParameterException: 'Please check the values you entered.',
};

async function call<T>(op: string, body: unknown): Promise<T> {
  const cfg = getConfig();
  let res: Response;
  try {
    res = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${op}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError('NetworkError', 'Network error. Check your connection and try again.');
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const code = String(json.__type ?? 'Error').split('#').pop()!;
    // the pre sign-up trigger (email allowlist) explains itself; drop Cognito's prefix
    if (code === 'UserLambdaValidationException') throw new AuthError(code, String(json.message ?? '').replace(/^PreSignUp failed with error /, ''));
    throw new AuthError(code, FRIENDLY[code] ?? json.message ?? 'Something went wrong.');
  }
  return json as T;
}

// ---------- token storage ----------
// "Keep me signed in" keeps the tokens in localStorage (survives browser restarts, shared by all tabs);
// otherwise they live in sessionStorage and the session ends when the tab is closed.
interface Tokens { idToken: string; accessToken: string; refreshToken: string; email: string }
const KEY = 'wgo.tokens';
let tokens: Tokens | null = load();
const listeners = new Set<() => void>();
function read(store: Storage): Tokens | null {
  try { return JSON.parse(store.getItem(KEY) ?? 'null'); } catch { return null; }
}
function load(): Tokens | null { return read(localStorage) ?? read(sessionStorage); }
function save(t: Tokens | null, persist = !!read(localStorage) || !read(sessionStorage)) {
  tokens = t;
  localStorage.removeItem(KEY); sessionStorage.removeItem(KEY);
  if (t) (persist ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(t));
  changed();
}
function changed() { scheduleRefresh(); listeners.forEach((l) => l()); }
// Another tab signed in, refreshed or signed out: pick up its tokens instead of using stale ones.
window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) { tokens = load(); changed(); } });
/** Local development: fake a long-lived session for `email` (see RuntimeConfig.devEmail). */
export function devSignIn(email: string) {
  if (tokens?.email === email) return;
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
  const jwt = `${b64({ alg: 'none' })}.${b64({ email, exp: Math.floor(Date.now() / 1000) + 365 * 86400 })}.dev`;
  save({ idToken: jwt, accessToken: jwt, refreshToken: '', email });
}
/** Re-read tokens from localStorage (used by the mock's auto-login). */
export function reloadTokens() { tokens = load(); changed(); }
export function useAuth() {
  const t = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => tokens);
  return { signedIn: !!t, email: t?.email ?? null };
}

export function jwtExp(jwt: string): number {
  try {
    const p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (p.exp ?? 0) * 1000;
  } catch { return 0; }
}
function jwtEmail(jwt: string): string {
  try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email ?? ''; } catch { return ''; }
}

interface AuthResult { AuthenticationResult?: { IdToken: string; AccessToken: string; RefreshToken?: string }; ChallengeName?: string }

export async function signUp(email: string, password: string) {
  await call('SignUp', { ClientId: getConfig().userPoolClientId, Username: email, Password: password, UserAttributes: [{ Name: 'email', Value: email }] });
}
export async function confirmSignUp(email: string, code: string) {
  await call('ConfirmSignUp', { ClientId: getConfig().userPoolClientId, Username: email, ConfirmationCode: code });
}
export async function resendCode(email: string) {
  await call('ResendConfirmationCode', { ClientId: getConfig().userPoolClientId, Username: email });
}
export async function signIn(email: string, password: string, remember = true) {
  const r = await call<AuthResult>('InitiateAuth', {
    ClientId: getConfig().userPoolClientId, AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  const a = r.AuthenticationResult;
  if (!a) throw new AuthError('Challenge', `Unsupported sign-in challenge: ${r.ChallengeName ?? 'unknown'}`);
  save({ idToken: a.IdToken, accessToken: a.AccessToken, refreshToken: a.RefreshToken ?? '', email: jwtEmail(a.IdToken) || email }, remember);
}
export async function forgotPassword(email: string) {
  await call('ForgotPassword', { ClientId: getConfig().userPoolClientId, Username: email });
}
export async function confirmForgotPassword(email: string, code: string, password: string) {
  await call('ConfirmForgotPassword', { ClientId: getConfig().userPoolClientId, Username: email, ConfirmationCode: code, Password: password });
}
/**
 * Signs out this browser only: revokes this session's refresh token (and the access tokens issued from it).
 * GlobalSignOut would also end the user's sessions in every other browser and device.
 */
export async function signOut() {
  const t = tokens;
  save(null);
  if (t?.refreshToken) { try { await call('RevokeToken', { ClientId: getConfig().userPoolClientId, Token: t.refreshToken }); } catch { /* already revoked */ } }
}

let refreshing: Promise<boolean> | null = null;
export function refreshTokens(): Promise<boolean> {
  if (!tokens?.refreshToken) return Promise.resolve(false);
  if (refreshing) return refreshing;
  const cur = tokens;
  refreshing = (async () => {
    try {
      const r = await call<AuthResult>('InitiateAuth', {
        ClientId: getConfig().userPoolClientId, AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: cur.refreshToken },
      });
      const a = r.AuthenticationResult!;
      save({ ...cur, idToken: a.IdToken, accessToken: a.AccessToken, refreshToken: a.RefreshToken ?? cur.refreshToken });
      return true;
    } catch (e) {
      // Only a rejected refresh token ends the session; throttling, outages and network errors keep it for the next try.
      if (e instanceof AuthError && e.code === 'NotAuthorizedException' && tokens?.refreshToken === cur.refreshToken) save(null);
      return false;
    } finally { refreshing = null; }
  })();
  return refreshing;
}
/** Returns a valid ID token, refreshing if it expires within 90s. */
export async function getIdToken(): Promise<string | null> {
  if (!tokens) return null;
  if (jwtExp(tokens.idToken) - Date.now() < 90_000) await refreshTokens();
  return tokens?.idToken ?? null;
}

let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh() {
  clearTimeout(timer);
  if (!tokens) return;
  const wait = Math.max(5_000, jwtExp(tokens.idToken) - Date.now() - 120_000);
  timer = setTimeout(() => { void refreshTokens(); }, Math.min(wait, 2 ** 30));
}
scheduleRefresh();
