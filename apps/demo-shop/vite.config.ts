import { defineConfig } from 'vite';

/**
 * Demo shop dev server. The synthetic store backend (coupon, stock, payment, checkout, support chat) lives in
 * the API (apps/api/src/demo-store.ts), and so do the bug switches the dashboard sets, so /api and /v1/demo
 * are proxied to it (no CORS). All data is synthetic. Bug flags travel in the x-demo-bugs header.
 */
export default defineConfig({
  resolve: { conditions: ['source'] },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8082', '/v1/demo': 'http://127.0.0.1:8082' },
  },
});
