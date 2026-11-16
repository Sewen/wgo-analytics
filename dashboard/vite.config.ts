import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), tailwindcss()],
    server: { port: 5173 },
    // Statically replace the flag so the dynamic import of ./mock is tree-shaken out when it is unset.
    define: { 'import.meta.env.VITE_MOCK': JSON.stringify(env.VITE_MOCK ?? '') },
    build: { target: 'es2022', sourcemap: false },
  };
});
