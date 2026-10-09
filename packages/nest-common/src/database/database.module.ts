import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDatabase } from '@udemy/db';
import type { BaseEnv } from '../config/base-env.schema';
import { DbHealthIndicator } from '../health/db-health.indicator';
import { DATABASE, DATABASE_MODULE_OPTIONS, type Database } from './database.constants';
import { DatabaseLifecycle } from './database-lifecycle';

export interface DatabaseModuleOptions {
  /** Shown in `pg_stat_activity.application_name`, e.g. `udemy-api`. */
  applicationName: string;
}

/**
 * Global module that owns the single Kysely instance (and its pg pool) of the process.
 * Import once in the root module: `DatabaseModule.forRoot({ applicationName: 'udemy-api' })`.
 * Requires the global ConfigModule (DATABASE_URL, DATABASE_POOL_MAX).
 */
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        { provide: DATABASE_MODULE_OPTIONS, useValue: options },
        {
          provide: DATABASE,
          inject: [ConfigService, DATABASE_MODULE_OPTIONS],
          // The pool connects lazily, so creating it never blocks bootstrap.
          useFactory: (
            config: ConfigService<BaseEnv, true>,
            opts: DatabaseModuleOptions,
          ): Database =>
            createDatabase({
              connectionString: config.get('DATABASE_URL', { infer: true }),
              max: config.get('DATABASE_POOL_MAX', { infer: true }),
              applicationName: opts.applicationName,
            }),
        },
        DatabaseLifecycle,
        DbHealthIndicator,
      ],
      exports: [DATABASE, DbHealthIndicator],
    };
  }
}
