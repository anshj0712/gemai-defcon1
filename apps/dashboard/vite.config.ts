import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Dashboard dev server. /v1 is proxied to the local API, so there is no CORS to configure. */
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source'] },
  server: {
    port: 5174,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/v1': 'http://127.0.0.1:8082' },
  },
});
