import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { envInt, NODE_ENVS, validateEnv } from '@udemy/nest-common';
import { z } from 'zod';
import {
  kafkaBrokersEnv,
  MIN_PROCESSED_EVENTS_RETENTION_DAYS,
} from '../shared/config/worker-env.schema';

/**
 * The few variables the DLQ CLI reads. Deliberately NOT the full workerEnvSchema (nor
 * baseEnvSchema, which requires DATABASE_URL): the CLI must run with only Kafka settings at hand
 * (no SMTP/S3/DB secrets), and it never boots the WorkerModule (whose bootstrap would join the
 * shared consumer group). Same names and defaults as the worker.
 */
export const cliEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  KAFKA_BROKERS: kafkaBrokersEnv,
  KAFKA_CLIENT_ID: z.string().min(1).default('udemy-worker'),
  /** Only used to make sure the CLI's throw-away group can never be the worker's group. */
  KAFKA_GROUP_ID: z.string().min(1).default('udemy-worker'),
  PROCESSED_EVENTS_RETENTION_DAYS: envInt
    .min(MIN_PROCESSED_EVENTS_RETENTION_DAYS)
    .max(3650)
    .default(30),
});

export type CliEnv = z.output<typeof cliEnvSchema>;

/**
 * Like createConfigModule: in development the app's `.env`, then the monorepo root `.env`, fill
 * in variables that are not set (the process environment always wins). Production and test use
 * the environment only.
 */
export function loadCliEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): CliEnv {
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv !== 'production' && nodeEnv !== 'test' && env === process.env) {
    for (const file of [resolve(cwd, '.env'), resolve(cwd, '../../.env')]) {
      // loadEnvFile never overrides variables that are already set.
      if (existsSync(file)) process.loadEnvFile(file);
    }
  }
  return validateEnv(cliEnvSchema, env);
}
