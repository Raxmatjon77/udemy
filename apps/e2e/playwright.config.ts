import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

import {
  apiEnv,
  composeArgs,
  LOG_DIR,
  OUTPUT_DIR,
  ports,
  REPO_ROOT,
  transcoderEnv,
  transcoderMode,
  urls,
  webEnv,
  workerEnv,
  type AppName,
} from './src/env';

/**
 * End-to-end journeys against the REAL stack: the built api + worker + transcoder
 * (node dist/main.js, or the transcoder's compose service) and the three Next apps (next start),
 * on top of the docker dev stack (Postgres, Redis, Kafka + Debezium, MinIO, Mailpit). See
 * README.md for prerequisites, ports and env.
 *
 * Server output goes to .output/logs/<name>.log (gitignored), traces/screenshots/videos of
 * failed tests to .output/test-results and the HTML report to .output/report.
 */

mkdirSync(LOG_DIR, { recursive: true });

const SERVER_TIMEOUT_MS = 120_000;
const log = (name: string) => `> "${resolve(LOG_DIR, `${name}.log`)}" 2>&1`;

/**
 * The transcoder (design D5): leases media.transcode_jobs, so the course journey's uploads reach
 * READY. SIGTERM makes it kill ffmpeg and release its lease without an attempt penalty.
 * - host: `node dist/main.js` with the host ffmpeg (CI installs it with .github/actions/ffmpeg).
 * - compose: the dev compose `transcoder` service in the foreground (`up` without `-d`): SIGTERM
 *   to `docker compose` stops the container. The image is built when missing;
 *   E2E_TRANSCODER_BUILD=1 rebuilds it (after transcoder changes).
 */
function transcoderServer() {
  const common = {
    name: 'transcoder',
    url: `${urls.transcoder}/health/ready`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 30_000 },
  };
  if (transcoderMode === 'host') {
    return {
      ...common,
      command: `node dist/main.js ${log('transcoder')}`,
      cwd: resolve(REPO_ROOT, 'apps/transcoder'),
      env: transcoderEnv(),
      timeout: SERVER_TIMEOUT_MS,
    };
  }
  const build = process.env.E2E_TRANSCODER_BUILD === '1' ? ['--build'] : [];
  const args = [...composeArgs(), 'up', '--no-deps', '--no-log-prefix', '--no-color', ...build];
  return {
    ...common,
    command: `docker ${args.map((arg) => JSON.stringify(arg)).join(' ')} transcoder ${log('transcoder')}`,
    cwd: REPO_ROOT,
    env: {
      E2E_TRANSCODER_PORT: String(ports.transcoder),
      E2E_SERVER_LOG_LEVEL: process.env.E2E_SERVER_LOG_LEVEL ?? 'info',
    },
    // A first run builds the image (turbo prune + install + build): minutes, not seconds.
    timeout: 15 * 60_000,
  };
}

/** Specs that play H.264/AAC video: they need Google Chrome (Chromium builds lack the codecs). */
const CHROME_SPECS = /course-lifecycle\.spec\.ts$/;

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: CHROME_SPECS },
    // Branded Chrome (design §14, "Player codecs"): installed on the Mac and on ubuntu-latest.
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
      testMatch: CHROME_SPECS,
    },
  ],
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
    ...(transcoderMode === 'external' ? [] : [transcoderServer()]),
    nextApp('student'),
    nextApp('instructor'),
    nextApp('admin'),
  ],
});
