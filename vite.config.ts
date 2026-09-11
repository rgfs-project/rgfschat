import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `PORT` here is the *client* port; `scripts/dev.mjs` hands the API its own
// port and points the proxy at it via VITE_API_TARGET.
const CLIENT_PORT = Number(process.env['PORT'] ?? 5173);
const API_TARGET = process.env['VITE_API_TARGET'] ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: CLIENT_PORT,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
});
