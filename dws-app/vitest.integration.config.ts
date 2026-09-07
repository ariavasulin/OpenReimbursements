import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { assertLocalTestTarget } from './scripts/test-local-target.mjs';

assertLocalTestTarget();
if (!['db', 'routes', 'cutover'].includes(process.env.DWS_TEST_SUITE ?? '')) throw new Error('Select test:db, test:routes, or test:cutover');
export default defineConfig({
  envDir: false,
  resolve: { alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
    'server-only': fileURLToPath(new URL('./integration/server-only.ts', import.meta.url)),
  } },
  test: {
    environment: 'node',
    include: [`integration/${process.env.DWS_TEST_SUITE}/**/*.test.ts`],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
