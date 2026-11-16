import './lib/legacyStorage'; // first: moves old storage keys before anything reads them
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App';
import { loadConfig } from './api/config';
import { KIOSK_TOKEN } from './lib/kiosk';
import { KioskApp } from './kiosk/KioskApp';

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 20_000, gcTime: 10 * 60_000, retry: 1, refetchOnWindowFocus: false } },
});

const root = createRoot(document.getElementById('root')!);
async function boot() {
  try {
    if (import.meta.env.VITE_MOCK) {
      const { installMock } = await import('./mock');
      installMock();
    }
    await loadConfig();
    root.render(<StrictMode><QueryClientProvider client={qc}>{KIOSK_TOKEN ? <KioskApp /> : <App />}</QueryClientProvider></StrictMode>);
  } catch (e) {
    root.render(<div style={{ padding: 40, fontFamily: 'sans-serif', color: '#f87171' }}>Failed to start: {(e as Error).message}{KIOSK_TOKEN && ' · retrying…'}</div>);
    // a wall display may boot before its network is up: keep trying instead of staying on this message
    if (KIOSK_TOKEN) setTimeout(() => void boot(), 10_000);
  }
}
void boot();
