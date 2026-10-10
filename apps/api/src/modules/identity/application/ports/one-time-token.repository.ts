import type { DB, Executor, Transaction } from '@udemy/db';
import type { OneTimeTokenPurpose, OneTimeTokenState } from '../../domain/one-time-token';

/** One `identity.one_time_tokens` row, as the verify/reset use cases need it. */
export interface OneTimeTokenRow extends OneTimeTokenState {
  readonly id: string;
  readonly userId: string;
}

/**
 * `identity.one_time_tokens` from the api's side: lookup, consume, invalidate. Issuing is the
 * worker's job (D10): the api never inserts a token. All timestamps are SQL `now()`.
 *
 * Lock order (schema doc §6): the user row (`UserAccountRepository.lockAccount`) first, then the
 * token row. The worker's IssueOneTimeToken takes the same user lock before it touches tokens,
 * so the two never deadlock.
 */
export abstract class OneTimeTokenRepository {
  /** Unlocked lookup by `token_hash` (to find the owner before taking the per-user lock). */
  abstract findByHash(tokenHash: Buffer, ex?: Executor): Promise<OneTimeTokenRow | null>;

  /** `SELECT ... WHERE token_hash = $1 FOR UPDATE`. */
  abstract lockByHash(trx: Transaction<DB>, tokenHash: Buffer): Promise<OneTimeTokenRow | null>;

  /** `consumed_at = now()` (only if neither consumed nor invalidated). */
  abstract consume(trx: Transaction<DB>, tokenId: string): Promise<void>;

  /** `invalidated_at = now()` on every live token of that purpose; returns how many. */
  abstract invalidateLive(
    trx: Transaction<DB>,
    userId: string,
    purpose: OneTimeTokenPurpose,
  ): Promise<number>;
}
