import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Dashboard dev server. /v1 is proxied to the local API, so there is no CORS to configure. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['source'],
    // `@/` is src/, as shadcn's components.json expects.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5174,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/v1': 'http://127.0.0.1:8082' },
  },
});
