import { resolve } from 'node:path';
import type { DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { z } from 'zod';
import { validateEnv } from './validate-env';

export interface CreateConfigModuleOptions {
  /**
   * .env files to load, first match wins. Defaults to the app's own `.env`, then the
   * monorepo root `.env` (apps run with cwd = `apps/<name>`).
   */
  envFilePath?: string[];
}

/**
 * Global ConfigModule that validates the environment with a zod schema and fails fast:
 * an invalid env throws during bootstrap, before any provider is created.
 *
 * .env files are only read in development. In production (containers, k8s) the
 * environment is the single source; in tests it is whatever the test sets.
 */
export function createConfigModule<TSchema extends z.ZodType<Record<string, unknown>>>(
  schema: TSchema,
  options: CreateConfigModuleOptions = {},
): Promise<DynamicModule> {
  const nodeEnv = process.env.NODE_ENV;
  return ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    ignoreEnvFile: nodeEnv === 'production' || nodeEnv === 'test',
    envFilePath: options.envFilePath ?? [
      resolve(process.cwd(), '.env'),
      resolve(process.cwd(), '../../.env'),
    ],
    validate: (raw: Record<string, unknown>) => validateEnv(schema, raw),
  });
}
