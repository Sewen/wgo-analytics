# WGO dashboard

Vite + React 19 + TypeScript (strict) + Tailwind CSS v4 + TanStack Query + lucide-react. No chart library: all charts are small hand-written SVG components in `src/charts/`.

## Develop

```bash
npm install
npm run dev          # against a real backend (see config.json below)
npm run dev:mock     # fully in-browser mock backend, no AWS needed
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + production build into dist/
```

## Runtime config (`/config.json`)

On boot the app fetches `/config.json` (type `RuntimeConfig` in `src/api/contract.ts`). It is not baked into the bundle, so the same build can be deployed anywhere:

```json
{
  "apiUrl": "https://xxx.execute-api.eu-west-1.amazonaws.com",
  "ingestUrl": "https://xxx.execute-api.eu-west-1.amazonaws.com",
  "wsUrl": "wss://yyy.execute-api.eu-west-1.amazonaws.com/live",
  "sdkUrl": "https://dzzz.cloudfront.net/sdk/v1/wgo.js",
  "region": "eu-west-1",
  "userPoolId": "eu-west-1_XXXX",
  "userPoolClientId": "xxxxxxxx"
}
```

`public/config.json` holds placeholders for local dev. Set `VITE_CONFIG_URL` (for example in `.env.local`) to load a different file or URL.

## Mock mode

`VITE_MOCK=1 npm run dev` (or `npm run dev:mock`) installs an in-browser mock (`src/mock/`) that patches `fetch` (Cognito and `/api/*`) and `WebSocket`:

- Any email/password signs in; the sign-up confirmation code is `123456`.
- Every endpoint in the contract returns deterministic generated data that respects `from`/`to`. The mock WebSocket emits events every 150-500 ms, including clicks that match the example watches.
- Projects, members and write keys created in mock mode persist in `localStorage` (`analytico.mock.db`).
- URL flags: `?mock_autologin=1` signs in automatically and seeds four demo watches, `?mock_empty=1` starts with no projects (onboarding flow), `?mock_theme=light|dark`.
- The mock is loaded with a dynamic import behind `import.meta.env.VITE_MOCK`, which `vite.config.ts` replaces statically, so a normal `npm run build` contains no mock code.

To build a mock bundle for screenshots: `VITE_MOCK=1 npx vite build --outDir /tmp/wgo-mock-dist`.

## Auth

Cognito is called directly with `fetch` (`src/auth/cognito.ts`): SignUp, ConfirmSignUp, ResendConfirmationCode, InitiateAuth (`USER_PASSWORD_AUTH`, `REFRESH_TOKEN_AUTH`), ForgotPassword, ConfirmForgotPassword, GlobalSignOut. Tokens live in `localStorage`; the ID token is sent as `Authorization: Bearer`, refreshed before `exp`, and refreshed once and retried on a 401.

## URLs

Hash router, shareable: `#/p/<projectId>/<page>?range=24h` (`range` is `15m|1h|24h|7d|30d|custom`; `custom` adds `from`/`to` ISO strings). Pages: `overview live clicks errors network events traces logs metrics settings`; trace detail is `#/p/<pid>/traces/<traceId>`. Page-specific filters are also in the query (`type`, `q`, `sessionId`, `service`, `sev`, `traceId`, `m`, `agg`, `groupBy`...).

## Keyboard

`⌘K` / `Ctrl+K` opens the command palette. Shortcuts: `g o` overview, `g l` live, `g c` clicks, `g e` errors, `g n` network, `g v` events, `g t` traces, `g g` logs, `g m` metrics, `g s` settings.

## Layout

```
src/api       contract.ts (verbatim copy of backend/src/contract.ts), fetch client, react-query hooks
src/auth      Cognito client + auth screens
src/live      WebSocket client/store (watches, per-second buckets, firehose feed)
src/charts    TimeChart, Sparkline, BarList, Scatter
src/pages     one file per page
src/shell     sidebar/top bar, time picker, command palette
src/mock      in-browser mock backend (dev/screenshots only)
```
