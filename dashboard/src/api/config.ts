import type { RuntimeConfig } from './contract';

let config: RuntimeConfig | null = null;
export async function loadConfig(): Promise<RuntimeConfig> {
  const url = import.meta.env.VITE_CONFIG_URL || '/config.json';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  const c = (await res.json()) as RuntimeConfig;
  config = { ...c, apiUrl: c.apiUrl.replace(/\/$/, ''), ingestUrl: c.ingestUrl.replace(/\/$/, '') };
  if (config.devEmail) {
    // Local dev server: no Cognito. Sign in with an unsigned placeholder token the dev server ignores.
    const { devSignIn } = await import('../auth/cognito');
    devSignIn(config.devEmail);
  }
  return config;
}
export function getConfig(): RuntimeConfig {
  if (!config) throw new Error('Config not loaded');
  return config;
}
