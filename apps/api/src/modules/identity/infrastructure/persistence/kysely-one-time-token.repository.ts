import { Injectable } from '@nestjs/common';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type OneTimeTokenRow,
  OneTimeTokenRepository,
} from '../../application/ports/one-time-token.repository';
import { ONE_TIME_TOKEN_PURPOSES, type OneTimeTokenPurpose } from '../../domain/one-time-token';

/** The CHECK constraint guarantees the value; parse anyway so a bad row fails loudly. */
function purpose(value: string): OneTimeTokenPurpose {
  const found = ONE_TIME_TOKEN_PURPOSES.find((p) => p === value);
  if (found === undefined) throw new Error(`Unknown one-time token purpose "${value}"`);
  return found;
}

const COLUMNS = [
  'id',
  'userId',
  'purpose',
  'email',
  'expiresAt',
  'consumedAt',
  'invalidatedAt',
] as const;

@Injectable()
export class KyselyOneTimeTokenRepository extends OneTimeTokenRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async findByHash(tokenHash: Buffer, ex: Executor = this.db): Promise<OneTimeTokenRow | null> {
    const row = await ex
      .selectFrom('identity.oneTimeTokens')
      .select(COLUMNS)
      .where('tokenHash', '=', tokenHash)
      .executeTakeFirst();
    return row === undefined ? null : { ...row, purpose: purpose(row.purpose) };
  }

  async lockByHash(trx: Transaction<DB>, tokenHash: Buffer): Promise<OneTimeTokenRow | null> {
    const row = await trx
      .selectFrom('identity.oneTimeTokens')
      .select(COLUMNS)
      .where('tokenHash', '=', tokenHash)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : { ...row, purpose: purpose(row.purpose) };
  }

  async consume(trx: Transaction<DB>, tokenId: string): Promise<void> {
    await trx
      .updateTable('identity.oneTimeTokens')
      .set({ consumedAt: sql<Date>`now()` })
      .where('id', '=', tokenId)
      .where('consumedAt', 'is', null)
      .where('invalidatedAt', 'is', null)
      .execute();
  }

  async invalidateLive(
    trx: Transaction<DB>,
    userId: string,
    tokenPurpose: OneTimeTokenPurpose,
  ): Promise<number> {
    const result = await trx
      .updateTable('identity.oneTimeTokens')
      .set({ invalidatedAt: sql<Date>`now()` })
      .where('userId', '=', userId)
      .where('purpose', '=', tokenPurpose)
      .where('consumedAt', 'is', null)
      .where('invalidatedAt', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}
