/**
 * In-browser mock backend. Loaded only when VITE_MOCK is set (dynamic import in main.tsx).
 * Patches fetch (Cognito + /api/*) and WebSocket so the rest of the app is unchanged.
 */
import { handleApi, handleKiosk, MockHttpError } from './api';
import { MockWebSocket } from './ws';
import { reloadTokens } from '../auth/cognito';

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (email: string) => `${b64({ alg: 'none' })}.${b64({ email, sub: 'mock-' + email, exp: Math.floor(Date.now() / 1000) + 3600 })}.mock`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cogErr = (type: string, message: string) => json({ __type: type, message }, 400);

function emailFromAuth(h: Headers | undefined): string {
  const t = h?.get('Authorization')?.replace('Bearer ', '');
  try { return JSON.parse(atob(t!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email; } catch { return 'demo@wgo.dev'; }
}

async function cognito(target: string, body: Record<string, any>): Promise<Response> { // eslint-disable-line @typescript-eslint/no-explicit-any
  await delay(250);
  switch (target) {
    case 'SignUp': return json({ UserConfirmed: false, UserSub: 'mock' });
    case 'ConfirmSignUp': case 'ConfirmForgotPassword': return body.ConfirmationCode === '123456' ? json({}) : cogErr('CodeMismatchException', 'Invalid verification code provided, please try again.');
    case 'ResendConfirmationCode': case 'ForgotPassword': return json({ CodeDeliveryDetails: {} });
    case 'InitiateAuth': {
      const email = body.AuthFlow === 'REFRESH_TOKEN_AUTH' ? String(body.AuthParameters.REFRESH_TOKEN).replace('mock-refresh:', '') : String(body.AuthParameters.USERNAME);
      return json({ AuthenticationResult: { IdToken: jwt(email), AccessToken: jwt(email), RefreshToken: 'mock-refresh:' + email, ExpiresIn: 3600 } });
    }
    case 'GlobalSignOut': case 'RevokeToken': return json({});
  }
  return cogErr('InvalidParameterException', 'Unsupported operation ' + target);
}

export function installMock() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (url.hostname.startsWith('cognito-idp.')) {
      const target = new Headers(init?.headers).get('X-Amz-Target')?.split('.').pop() ?? '';
      return cognito(target, JSON.parse(String(init?.body ?? '{}')));
    }
    if (url.pathname.startsWith('/kiosk/v1/')) {
      await delay(60 + Math.random() * 140);
      try {
        return json(handleKiosk(url, new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '') ?? ''));
      } catch (e) {
        if (e instanceof MockHttpError) return json({ message: e.message }, e.status);
        throw e;
      }
    }
    if (url.pathname.startsWith('/api/')) {
      await delay(60 + Math.random() * 140);
      const headers = new Headers(init?.headers);
      try {
        return json(handleApi((init?.method ?? 'GET').toUpperCase(), url, init?.body ? JSON.parse(String(init.body)) : undefined, emailFromAuth(headers)));
      } catch (e) {
        if (e instanceof MockHttpError) return json({ message: e.message }, e.status);
        throw e;
      }
    }
    return realFetch(input, init);
  };
  window.WebSocket = MockWebSocket as unknown as typeof WebSocket;

  if (new URLSearchParams(location.search).has('mock_autologin') && !localStorage.getItem('wgo.tokens')) {
    const email = 'demo@wgo.dev';
    localStorage.setItem('wgo.tokens', JSON.stringify({ idToken: jwt(email), accessToken: jwt(email), refreshToken: 'mock-refresh:' + email, email }));
    reloadTokens();
    if (!localStorage.getItem('wgo.watches.prj_demo')) {
      localStorage.setItem('wgo.watches.prj_demo', JSON.stringify([
        { id: 'w_signup', label: 'Signup button', type: 'click', selector: '#signup-cta', name: 'signup-cta' },
        { id: 'w_cart', label: 'Add to cart', type: 'click', selector: 'button.add-to-cart' },
        { id: 'w_checkout', label: 'Checkout started', type: 'click', name: 'checkout' },
        { id: 'w_errors', label: 'JS errors', type: 'error' },
      ]));
    }
  }
  const theme = new URLSearchParams(location.search).get('mock_theme');
  if (theme) { document.documentElement.dataset.theme = theme; localStorage.setItem('wgo.theme', theme); }
  console.info('[wgo] mock mode: any credentials work, confirmation code is 123456');
}
