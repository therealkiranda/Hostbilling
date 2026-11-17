import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the storefront calls /api, which is forwarded to the local API so the
// browser never needs cross-origin access. In production set VITE_API_URL at build time
// or serve both behind one domain.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.HOSTBILLING_API_URL ?? 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'node',
  },
});
