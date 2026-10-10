import { Injectable } from '@nestjs/common';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type { BanRecord } from '../../application/dto';
import { UserBanRepository } from '../../application/ports/user-ban.repository';
import { BAN_COLUMNS, toBanRecord } from './ban-row';
import { mapIdentityConstraints } from './identity-constraint-errors';

@Injectable()
export class KyselyUserBanRepository extends UserBanRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async findActive(userId: string, ex: Executor = this.db): Promise<BanRecord | null> {
    const row = await ex
      .selectFrom('identity.userBans')
      .select(BAN_COLUMNS)
      .where('userId', '=', userId)
      .where('liftedAt', 'is', null)
      .executeTakeFirst();
    return row === undefined ? null : toBanRecord(row);
  }

  async list(userId: string, ex: Executor = this.db): Promise<BanRecord[]> {
    const rows = await ex
      .selectFrom('identity.userBans')
      .select(BAN_COLUMNS)
      .where('userId', '=', userId)
      .orderBy('bannedAt', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toBanRecord);
  }

  async insert(
    trx: Transaction<DB>,
    ban: { userId: string; bannedBy: string; reason: string },
  ): Promise<BanRecord> {
    const row = await mapIdentityConstraints(() =>
      trx
        .insertInto('identity.userBans')
        .values({ ...ban, bannedAt: sql<Date>`now()` })
        .returning(BAN_COLUMNS)
        .executeTakeFirstOrThrow(),
    );
    return toBanRecord(row);
  }

  async lift(
    trx: Transaction<DB>,
    lift: { userId: string; liftedBy: string; liftReason: string | null },
  ): Promise<BanRecord | null> {
    const row = await mapIdentityConstraints(() =>
      trx
        .updateTable('identity.userBans')
        .set({ liftedAt: sql<Date>`now()`, liftedBy: lift.liftedBy, liftReason: lift.liftReason })
        .where('userId', '=', lift.userId)
        .where('liftedAt', 'is', null)
        .returning(BAN_COLUMNS)
        .executeTakeFirst(),
    );
    return row === undefined ? null : toBanRecord(row);
  }
}
