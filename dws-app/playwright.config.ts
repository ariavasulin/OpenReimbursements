import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

if (!process.env.DWS_BROWSER_APP_DIR || !process.env.DWS_BROWSER_BASE_URL) {
  throw new Error('Use npm run test:browser: it creates and verifies an isolated backend first.');
}

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  outputDir: './test-results/browser',
  reporter: [['list'], ['json', { outputFile: 'test-results/browser-assertions.json' }]],
  use: {
    browserName: 'chromium', baseURL: process.env.DWS_BROWSER_BASE_URL,
    viewport: { width: 1440, height: 1000 }, trace: 'on', screenshot: 'only-on-failure',
  },
  webServer: {
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve('node_modules/next/dist/bin/next'))} dev --hostname localhost --port ${Number(process.env.DWS_BROWSER_PORT)}`,
    cwd: process.env.DWS_BROWSER_APP_DIR,
    url: `${process.env.DWS_BROWSER_BASE_URL}/migrate`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'ignore', stderr: 'pipe',
  },
});
