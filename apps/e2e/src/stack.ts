import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { resolve } from 'node:path';

import { apiEnv, infra, REPO_ROOT } from './env';
import { Mailpit } from './mailpit';
import { createPool } from './db';

/** Checks that the docker dev stack answers before any journey runs. */
export async function assertStackReachable(): Promise<void> {
  const problems: string[] = [];
  const check = async (name: string, probe: () => Promise<void>) => {
    try {
      await probe();
    } catch (error) {
      problems.push(`- ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await check(`Postgres (${redact(infra.databaseUrl)})`, async () => {
    const pool = createPool();
    try {
      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n from information_schema.tables
          where table_schema = 'identity' and table_name = 'users'`,
      );
      if (rows[0]?.n !== 1) throw new Error('identity.users is missing: run the migrations');
    } finally {
      await pool.end();
    }
  });
  await check(`Redis (${infra.redisUrl})`, () => redisPing(infra.redisUrl));
  await check(`Kafka (${infra.kafkaBrokers})`, () => {
    const [host = 'localhost', port = '9092'] = (infra.kafkaBrokers.split(',')[0] ?? '').split(':');
    return tcpProbe(host, Number(port));
  });
  await check(`Mailpit (${infra.mailpitUrl})`, async () => {
    await new Mailpit().info();
  });
  await check(
    `Debezium connector "${infra.debeziumConnector}" (${infra.kafkaConnectUrl})`,
    async () => {
      const response = await fetch(
        `${infra.kafkaConnectUrl}/connectors/${infra.debeziumConnector}/status`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) throw new Error(`status ${response.status}`);
      const status = (await response.json()) as {
        connector: { state: string };
        tasks: { state: string }[];
      };
      const states = [status.connector.state, ...status.tasks.map((t) => t.state)];
      if (states.some((s) => s !== 'RUNNING') || status.tasks.length === 0) {
        throw new Error(`not RUNNING: ${states.join(', ')}`);
      }
    },
  );

  if (problems.length > 0) {
    throw new Error(
      `The docker dev stack is not reachable:\n${problems.join('\n')}\n\n` +
        'Start it with: docker compose --env-file .env -f infra/docker/docker-compose.dev.yml up -d\n' +
        'and apply the migrations: pnpm --filter @udemy/db migrate:latest (see apps/e2e/README.md).',
    );
  }
}

function redact(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]+@/, '//$1:***@');
}

function tcpProbe(host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host, port, timeout: 3000 });
    socket.once('connect', () => {
      socket.end();
      resolvePromise();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.once('error', reject);
  });
}

function redisPing(redisUrl: string): Promise<void> {
  const url = new URL(redisUrl);
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 6379), timeout: 3000 });
    socket.once('connect', () => socket.write('PING\r\n'));
    socket.once('data', (data) => {
      socket.end();
      const reply = data.toString();
      if (reply.startsWith('+PONG')) resolvePromise();
      else reject(new Error(`unexpected reply ${JSON.stringify(reply.trim())}`));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.once('error', reject);
  });
}

export interface E2eAdmin {
  userId: string;
  email: string;
  password: string;
  displayName: string;
}

/**
 * Creates a fresh ADMIN for this run with `admin:bootstrap` (the api CLI, run from apps/api/dist)
 * and a random password passed on stdin. A new email every run: the CLI never changes the
 * password of an existing account, and a fresh account means no state leaks between runs.
 */
export async function bootstrapE2eAdmin(): Promise<E2eAdmin> {
  const suffix = randomBytes(5).toString('hex');
  const admin = {
    email: `e2e-admin-${suffix}@example.test`,
    displayName: `E2E Admin ${suffix}`,
    // 32 base64url chars: passes the password policy and is never written anywhere.
    password: randomBytes(24).toString('base64url'),
  };
  const apiDir = resolve(REPO_ROOT, 'apps/api');
  const { stdout, stderr, code } = await run(
    process.execPath,
    [
      'dist/modules/users/presentation/cli/main.js',
      'admin:bootstrap',
      '--email',
      admin.email,
      '--display-name',
      admin.displayName,
      '--password-stdin',
    ],
    { cwd: apiDir, env: { ...process.env, ...apiEnv() }, stdin: admin.password },
  );
  if (code !== 0) {
    throw new Error(
      `admin:bootstrap failed (exit ${code}). Did you build the api (pnpm --filter @udemy/api build)?\n${stderr}`,
    );
  }
  const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
    userId?: string;
    created?: boolean;
  };
  if (!result.userId || !result.created) {
    throw new Error(`admin:bootstrap did not create a new admin: ${stdout}`);
  }
  return { ...admin, userId: result.userId };
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ stdout, stderr, code }));
    child.stdin.end(options.stdin);
  });
}
