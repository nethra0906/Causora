import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, Vite serves the UI on :5173 and proxies API calls to the platform on :4000.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4000', '/v1': 'http://127.0.0.1:4000' } },
});
