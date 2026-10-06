import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Tests import workspace packages from source, so `pnpm test` needs no build first. Exact matches only. */
const alias = [
  { find: /^@cp\/schema\/tags$/, replacement: here('./packages/schema/src/tags.ts') },
  { find: /^@cp\/schema$/, replacement: here('./packages/schema/src/index.ts') },
  { find: /^@cp\/logger$/, replacement: here('./packages/logger/src/index.ts') },
  { find: /^@cp\/platform$/, replacement: here('./packages/platform/src/index.ts') },
  { find: /^@cp\/normalizer$/, replacement: here('./packages/normalizer/src/index.ts') },
  { find: /^@cp\/detectors$/, replacement: here('./packages/detectors/src/index.ts') },
  { find: /^@cp\/testkit$/, replacement: here('./packages/testkit/src/index.ts') },
];

const project = (name: string, dir: string) => ({
  extends: true as const,
  test: { name, include: [`${dir}/test/**/*.test.ts`] },
});

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    projects: [
      project('@cp/schema', 'packages/schema'),
      project('@cp/logger', 'packages/logger'),
      project('@cp/platform', 'packages/platform'),
      project('@cp/normalizer', 'packages/normalizer'),
      project('@cp/detectors', 'packages/detectors'),
      project('@cp/collector', 'apps/collector'),
      project('@cp/processor', 'apps/processor'),
      project('@cp/clusterer', 'apps/clusterer'),
      project('@cp/api', 'apps/api'),
      project('@cp/sdk', 'apps/sdk'),
      project('@cp/dashboard', 'apps/dashboard'),
      project('@cp/infra', 'infra'),
      project('@cp/sim', 'sim'),
    ],
  },
});
