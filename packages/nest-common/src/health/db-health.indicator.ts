import { Injectable, Logger } from '@nestjs/common';
import { sql } from '@udemy/db';
import { type Database } from '../database/database.constants';
import { InjectDatabase } from '../database/inject-database.decorator';
import { type HealthIndicatorResult, indicatorResult } from './health-indicator-result';

const DEFAULT_TIMEOUT_MS = 1_000;

/**
 * Readiness check: can we run `select 1` within the timeout?
 * Usage with terminus: `this.health.check([() => this.db.check('database')])`.
 * Terminus treats a `down` result as failure and answers 503.
 */
@Injectable()
export class DbHealthIndicator {
  private readonly logger = new Logger(DbHealthIndicator.name);

  constructor(@InjectDatabase() private readonly db: Database) {}

  async check<TKey extends string>(
    key: TKey,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<HealthIndicatorResult<TKey>> {
    const startedAt = performance.now();
    try {
      await this.withTimeout(sql`select 1`.execute(this.db), timeoutMs);
      const responseTimeMs = Math.round(performance.now() - startedAt);
      return indicatorResult(key, 'up', { responseTimeMs });
    } catch (error) {
      // Full error goes to the log; the (public) health response stays generic.
      this.logger.warn({ err: error }, 'Database health check failed');
      return indicatorResult(key, 'down', { message: 'Database is unreachable' });
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
