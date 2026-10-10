import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

import {
  apiEnv,
  LOG_DIR,
  OUTPUT_DIR,
  REPO_ROOT,
  urls,
  webEnv,
  workerEnv,
  type AppName,
} from './src/env';

/**
 * End-to-end journeys against the REAL stack: the built api + worker (node dist/main.js) and
 * the three Next apps (next start), on top of the docker dev stack (Postgres, Redis, Kafka +
 * Debezium, Mailpit). See README.md for prerequisites, ports and env.
 *
 * Server output goes to .output/logs/<name>.log (gitignored), traces/screenshots/videos of
 * failed tests to .output/test-results and the HTML report to .output/report.
 */

mkdirSync(LOG_DIR, { recursive: true });

const SERVER_TIMEOUT_MS = 120_000;
const log = (name: string) => `> "${resolve(LOG_DIR, `${name}.log`)}" 2>&1`;

const nextApp = (app: AppName) => ({
  name: `web-${app}`,
  command: `node_modules/.bin/next start --port ${webEnv(app).PORT} ${log(`web-${app}`)}`,
  cwd: resolve(REPO_ROOT, `apps/web-${app}`),
  url: `${urls[app]}/api/health`,
  env: webEnv(app),
  reuseExistingServer: false,
  timeout: SERVER_TIMEOUT_MS,
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
});

export default defineConfig({
  testDir: './tests',
  outputDir: resolve(OUTPUT_DIR, 'test-results'),
  globalSetup: './src/global-setup.ts',
  globalTeardown: './src/global-teardown.ts',
  // One shared dev stack on a small Docker VM: run the journeys one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Journeys wait for real emails (outbox → Debezium → Kafka → worker → Mailpit).
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: resolve(OUTPUT_DIR, 'report'), open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      name: 'api',
      command: `node dist/main.js ${log('api')}`,
      cwd: resolve(REPO_ROOT, 'apps/api'),
      url: `${urls.api}/api/health/ready`,
      env: apiEnv(),
      reuseExistingServer: false,
      timeout: SERVER_TIMEOUT_MS,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
    {
      name: 'worker',
      command: `node dist/main.js ${log('worker')}`,
      cwd: resolve(REPO_ROOT, 'apps/worker'),
      url: `${urls.worker}/health/ready`,
      env: workerEnv(),
      reuseExistingServer: false,
      timeout: SERVER_TIMEOUT_MS,
      // SIGTERM lets the worker commit its Kafka offsets and leave the group cleanly.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
    nextApp('student'),
    nextApp('instructor'),
    nextApp('admin'),
  ],
});
