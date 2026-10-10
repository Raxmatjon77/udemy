import { Injectable } from '@nestjs/common';
import { type DB, sql, type Transaction } from '@udemy/db';
import type { OneTimeTokenPurpose } from './one-time-token';
import {
  type LockedTokenOwner,
  type NewOneTimeToken,
  OneTimeTokenStore,
  type StoredOneTimeToken,
} from './one-time-token.store';

/** OneTimeTokenStore over `@udemy/db` (the worker never imports api code). */
@Injectable()
export class KyselyOneTimeTokenStore extends OneTimeTokenStore {
  async lockOwner(trx: Transaction<DB>, userId: string): Promise<LockedTokenOwner | null> {
    const row = await trx
      .selectFrom('identity.users')
      .select(['email', sql<Date>`now()`.as('now')])
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row ?? null;
  }

  async hasNewerRequest(
    trx: Transaction<DB>,
    userId: string,
    purpose: OneTimeTokenPurpose,
    requestedAt: Date,
  ): Promise<boolean> {
    // one_time_tokens_user_id_purpose_requested_at_idx
    const row = await trx
      .selectFrom('identity.oneTimeTokens')
      .select(sql.lit(1).as('one'))
      .where('userId', '=', userId)
      .where('purpose', '=', purpose)
      .where('requestedAt', '>', requestedAt)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async invalidateOthers(
    trx: Transaction<DB>,
    userId: string,
    purpose: OneTimeTokenPurpose,
    sourceEventId: string,
  ): Promise<number> {
    // No expires_at filter: expired-but-unconsumed tokens still occupy the live slot (§14).
    const result = await trx
      .updateTable('identity.oneTimeTokens')
      .set({ invalidatedAt: sql<Date>`now()` })
      .where('userId', '=', userId)
      .where('purpose', '=', purpose)
      .where('consumedAt', 'is', null)
      .where('invalidatedAt', 'is', null)
      .where('sourceEventId', '<>', sourceEventId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async insertIfAbsent(trx: Transaction<DB>, token: NewOneTimeToken): Promise<void> {
    await trx
      .insertInto('identity.oneTimeTokens')
      .values({
        userId: token.userId,
        purpose: token.purpose,
        tokenHash: token.tokenHash,
        email: token.email,
        sourceEventId: token.sourceEventId,
        requestedAt: token.requestedAt,
        expiresAt: token.expiresAt,
      })
      .onConflict((oc) => oc.column('sourceEventId').doNothing())
      .execute();
  }

  async findBySourceEvent(
    trx: Transaction<DB>,
    sourceEventId: string,
  ): Promise<StoredOneTimeToken | null> {
    const row = await trx
      .selectFrom('identity.oneTimeTokens')
      .select(['tokenHash', 'consumedAt', 'invalidatedAt'])
      .where('sourceEventId', '=', sourceEventId)
      .executeTakeFirst();
    return row === undefined
      ? null
      : { tokenHash: row.tokenHash, live: row.consumedAt === null && row.invalidatedAt === null };
  }
}
