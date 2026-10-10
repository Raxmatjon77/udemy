#!/usr/bin/env node
/**
 * Registers (or updates) a Kafka Connect connector from a JSON config file, then waits until the
 * connector and all of its tasks are RUNNING. Plain Node 22+, no dependencies.
 *
 *   node infra/ci/register-connector.mjs [--url http://kafka-connect:8083] [--name udemy-outbox]
 *     [--config infra/debezium/outbox-connector.json] [--set key=value ...] [--timeout 180]
 *     [--wait-only]
 *
 * --set        overrides one config key (repeatable), e.g. `--set database.hostname=postgres`
 * --wait-only  do not PUT the config; only wait for an already registered connector
 *
 * `PUT /connectors/<name>/config` is idempotent: it creates the connector or updates it in place.
 * Used by the GitLab `e2e` job and by infra/ci/e2e-local.sh.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.KAFKA_CONNECT_URL ?? 'http://localhost:8083' },
    name: { type: 'string', default: 'udemy-outbox' },
    config: { type: 'string', default: 'infra/debezium/outbox-connector.json' },
    set: { type: 'string', multiple: true, default: [] },
    timeout: { type: 'string', default: '180' },
    'wait-only': { type: 'boolean', default: false },
  },
});

const baseUrl = args.url.replace(/\/+$/, '');
const deadline = Date.now() + Number(args.timeout) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stdout.write(`[connector ${args.name}] ${msg}\n`);

function fail(msg) {
  process.stderr.write(`[connector ${args.name}] ERROR: ${msg}\n`);
  process.exit(1);
}

async function request(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

// 1. Kafka Connect REST answers (it starts slowly: JVM + internal topics).
for (;;) {
  try {
    if ((await request('GET', '/connectors')).status === 200) break;
  } catch {
    // not up yet
  }
  if (Date.now() > deadline) fail(`Kafka Connect at ${baseUrl} did not answer`);
  log(`waiting for Kafka Connect at ${baseUrl}...`);
  await sleep(3000);
}

// 2. Register / update.
if (!args['wait-only']) {
  const configPath = isAbsolute(args.config) ? args.config : resolve(REPO_ROOT, args.config);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  for (const pair of args.set) {
    const eq = pair.indexOf('=');
    if (eq <= 0) fail(`--set expects key=value, got ${JSON.stringify(pair)}`);
    config[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const { status, json } = await request('PUT', `/connectors/${args.name}/config`, config);
  if (status !== 200 && status !== 201) {
    fail(`PUT config returned ${status}: ${JSON.stringify(json)}`);
  }
  log(
    `${status === 201 ? 'created' : 'updated'} (database.hostname=${config['database.hostname']})`,
  );
}

// 3. Wait for RUNNING. A FAILED task does not recover by itself: print its trace and stop.
let last = '';
for (;;) {
  const { status, json } = await request('GET', `/connectors/${args.name}/status`).catch(() => ({
    status: 0,
    json: null,
  }));
  if (status === 200) {
    const tasks = json.tasks ?? [];
    const states = [json.connector.state, ...tasks.map((t) => t.state)];
    const failed = tasks.find((t) => t.state === 'FAILED');
    if (json.connector.state === 'FAILED' || failed) {
      fail(`FAILED:\n${failed?.trace ?? json.connector.trace ?? JSON.stringify(json)}`);
    }
    if (tasks.length > 0 && states.every((s) => s === 'RUNNING')) {
      log(`RUNNING (${tasks.length} task${tasks.length > 1 ? 's' : ''})`);
      break;
    }
    last = states.join(', ');
  } else {
    last = `status endpoint returned ${status}`;
  }
  if (Date.now() > deadline) fail(`not RUNNING after ${args.timeout}s (last: ${last})`);
  await sleep(2000);
}
