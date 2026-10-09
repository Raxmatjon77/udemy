import { z } from 'zod';
import { envInt } from './env-helpers';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Variables every Nest process needs. Apps extend it:
 * `export const apiEnvSchema = baseEnvSchema.extend({ PORT: envPort.default(4000) })`.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: envInt.min(1).default(10),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type NodeEnv = BaseEnv['NODE_ENV'];
export type LogLevel = BaseEnv['LOG_LEVEL'];
