import { defineConfig } from 'vite';

/** `pnpm --filter @cp/sdk bundle`: the one-tag IIFE build (bundle/cp-sdk.js). */
export default defineConfig({
  resolve: { conditions: ['source'] },
  build: {
    outDir: 'bundle',
    emptyOutDir: true,
    target: 'es2020',
    lib: {
      entry: 'src/snippet.ts',
      name: 'cpSdk',
      formats: ['iife'],
      fileName: () => 'cp-sdk.js',
    },
    reportCompressedSize: true,
  },
});
