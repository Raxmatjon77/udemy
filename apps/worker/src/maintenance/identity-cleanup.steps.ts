import {
  type DB,
  deleteConsumedRefreshTokens,
  deleteExpiredOneTimeTokens,
  deleteExpiredSessions,
  purgeSecurityEvents,
  type Transaction,
} from '@udemy/db';

/** One batch of one cleanup statement: rows deleted, and whether a full batch suggests more. */
export interface CleanupBatchResult {
  readonly deleted: number;
  readonly more: boolean;
}

export interface CleanupStep {
  readonly name: string;
  runBatch(trx: Transaction<DB>): Promise<CleanupBatchResult>;
}

export interface IdentityCleanupOptions {
  readonly graceDays: number;
  readonly tokenBatchSize: number;
  readonly sessionBatchSize: number;
  readonly securityEventBatchSize: number;
}

/**
 * The retention statements of schema doc §8, in order, over the `@udemy/db` maintenance
 * functions: consumed refresh tokens (A), expired/revoked sessions with their tokens (B1–B3),
 * one-time tokens (C), security_events older than 180 days (D).
 */
export function identityCleanupSteps(options: IdentityCleanupOptions): CleanupStep[] {
  const { graceDays, tokenBatchSize, sessionBatchSize, securityEventBatchSize } = options;
  return [
    {
      name: 'refresh_tokens',
      async runBatch(trx) {
        const deleted = await deleteConsumedRefreshTokens(trx, {
          graceDays,
          batchSize: tokenBatchSize,
        });
        return { deleted, more: deleted >= tokenBatchSize };
      },
    },
    {
      name: 'sessions',
      async runBatch(trx) {
        const r = await deleteExpiredSessions(trx, { graceDays, batchSize: sessionBatchSize });
        return {
          deleted: r.absoluteExpired + r.revoked + r.idleExpired,
          more: Math.max(r.absoluteExpired, r.revoked, r.idleExpired) >= sessionBatchSize,
        };
      },
    },
    {
      name: 'one_time_tokens',
      async runBatch(trx) {
        const deleted = await deleteExpiredOneTimeTokens(trx, {
          graceDays,
          batchSize: tokenBatchSize,
        });
        return { deleted, more: deleted >= tokenBatchSize };
      },
    },
    {
      name: 'security_events',
      async runBatch(trx) {
        const deleted = await purgeSecurityEvents(trx, securityEventBatchSize);
        return { deleted, more: deleted >= securityEventBatchSize };
      },
    },
  ];
}
