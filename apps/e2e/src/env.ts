import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * Ports, URLs and per-process environment of the e2e stack. Everything is derived from a
 * handful of `E2E_*` variables so the suite can run next to processes that already hold the
 * default ports (the cookie, Origin and CSRF checks need every origin to match exactly).
 *
 * The root `.env` and the apps' `.env.local` are READ (never loaded into `process.env`), so the
 * Playwright process stays clean and each server gets exactly what it is given here.
 */

export const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(E2E_DIR, '../..');
export const OUTPUT_DIR = resolve(E2E_DIR, '.output');
export const LOG_DIR = resolve(OUTPUT_DIR, 'logs');

function readEnvFile(...candidates: string[]): Record<string, string> {
  for (const file of candidates) {
    if (existsSync(file)) return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
  }
  return {};
}

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be a TCP port, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** The root `.env` (falls back to `.env.example`), as the api and the worker see it. */
export const rootEnv = readEnvFile(resolve(REPO_ROOT, '.env'), resolve(REPO_ROOT, '.env.example'));

export const ports = {
  api: port('E2E_API_PORT', 4000),
  worker: port('E2E_WORKER_PORT', 4001),
  student: port('E2E_STUDENT_PORT', 3000),
  instructor: port('E2E_INSTRUCTOR_PORT', 3001),
  admin: port('E2E_ADMIN_PORT', 3002),
} as const;

/** Always `localhost`: Chromium accepts `Secure` (and so `__Host-`) cookies on it over http. */
export const urls = {
  api: `http://localhost:${ports.api}`,
  worker: `http://localhost:${ports.worker}`,
  student: `http://localhost:${ports.student}`,
  instructor: `http://localhost:${ports.instructor}`,
  admin: `http://localhost:${ports.admin}`,
} as const;

export type AppName = 'student' | 'instructor' | 'admin';

export const infra = {
  databaseUrl:
    process.env.E2E_DATABASE_URL ??
    rootEnv.DATABASE_URL ??
    'postgres://udemy:udemy@localhost:55432/udemy',
  redisUrl: process.env.E2E_REDIS_URL ?? rootEnv.REDIS_URL ?? 'redis://localhost:56379',
  kafkaBrokers: process.env.E2E_KAFKA_BROKERS ?? rootEnv.KAFKA_BROKERS ?? 'localhost:9092',
  mailpitUrl: process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025',
  kafkaConnectUrl: process.env.E2E_KAFKA_CONNECT_URL ?? 'http://localhost:8083',
  debeziumConnector: process.env.E2E_DEBEZIUM_CONNECTOR ?? 'udemy-outbox',
} as const;

/** Env overrides for `node dist/main.js` in apps/api (the rest comes from the root .env). */
export function apiEnv(): Record<string, string> {
  return {
    PORT: String(ports.api),
    // The JWT `iss`; the BFFs' JWT_ISSUER below must be the same string.
    API_PUBLIC_URL: urls.api,
    LOG_LEVEL: process.env.E2E_SERVER_LOG_LEVEL ?? 'info',
  };
}

/** Env overrides for `node dist/main.js` in apps/worker. */
export function workerEnv(): Record<string, string> {
  return {
    WORKER_HEALTH_PORT: String(ports.worker),
    // Links in emails must point at the origins the browser uses.
    STUDENT_APP_ORIGIN: urls.student,
    INSTRUCTOR_APP_ORIGIN: urls.instructor,
    ADMIN_APP_ORIGIN: urls.admin,
    LOG_LEVEL: process.env.E2E_SERVER_LOG_LEVEL ?? 'info',
  };
}

/**
 * Full server env of one Next BFF for `next start`. The client secret comes from the app's
 * `.env.local` (else `.env.example`, whose dev placeholder matches the root .env hash).
 */
export function webEnv(app: AppName): Record<string, string> {
  const appDir = resolve(REPO_ROOT, `apps/web-${app}`);
  const local = readEnvFile(resolve(appDir, '.env.local'), resolve(appDir, '.env.example'));
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: String(ports[app]),
    API_INTERNAL_URL: urls.api,
    API_CLIENT_ID: local.API_CLIENT_ID ?? `${app}-bff`,
    API_CLIENT_SECRET: local.API_CLIENT_SECRET ?? '',
    APP_ORIGIN: urls[app],
    JWT_ISSUER: urls.api,
    JWT_AUDIENCE: rootEnv.JWT_AUDIENCE ?? 'udemy-api',
    JWKS_URL: `${urls.api}/.well-known/jwks.json`,
    COOKIE_SECURE: 'true',
  };
  if (app === 'instructor') env.STUDENT_APP_ORIGIN = urls.student;
  return env;
}

/** Cookie names of each BFF (`__Host-udemy-{app}-{rt|at}` with COOKIE_SECURE=true). */
export function cookieName(app: AppName, kind: 'rt' | 'at'): string {
  return `__Host-udemy-${app}-${kind}`;
}
