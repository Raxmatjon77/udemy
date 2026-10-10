import { Injectable } from '@nestjs/common';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type AccountRecord,
  type InsertedAccount,
  type NewAccount,
  UserAccountRepository,
} from '../../application/ports/user-account.repository';
import { mapIdentityConstraints } from './identity-constraint-errors';

@Injectable()
export class KyselyUserAccountRepository extends UserAccountRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  private selectAccount(ex: Executor) {
    return ex.selectFrom('identity.users as u').select((eb) => [
      'u.id',
      'u.email',
      'u.displayName',
      'u.passwordHash',
      'u.emailVerifiedAt',
      'u.createdAt',
      eb
        .exists(
          eb
            .selectFrom('identity.userBans as b')
            .select(sql.lit(1).as('one'))
            .whereRef('b.userId', '=', 'u.id')
            .where('b.liftedAt', 'is', null),
        )
        .$castTo<boolean>()
        .as('banned'),
    ]);
  }

  async findByEmail(email: string, ex: Executor = this.db): Promise<AccountRecord | null> {
    // citext: the comparison is case-insensitive; the value is already normalised anyway.
    return (await this.selectAccount(ex).where('u.email', '=', email).executeTakeFirst()) ?? null;
  }

  async findById(userId: string, ex: Executor = this.db): Promise<AccountRecord | null> {
    return (await this.selectAccount(ex).where('u.id', '=', userId).executeTakeFirst()) ?? null;
  }

  async insertIfAbsent(trx: Transaction<DB>, account: NewAccount): Promise<InsertedAccount | null> {
    const row = await mapIdentityConstraints(() =>
      trx
        .insertInto('identity.users')
        .values({
          email: account.email,
          displayName: account.displayName,
          passwordHash: account.passwordHash,
          passwordChangedAt: sql<Date>`now()`,
          emailVerifiedAt: account.emailVerified ? sql<Date>`now()` : null,
        })
        .onConflict((oc) => oc.column('email').doNothing())
        .returning(['id', 'createdAt'])
        .executeTakeFirst(),
    );
    return row ?? null;
  }

  async replacePasswordHash(trx: Transaction<DB>, userId: string, hash: string): Promise<void> {
    await trx
      .updateTable('identity.users')
      .set({ passwordHash: hash })
      .where('id', '=', userId)
      .execute();
  }

  async updateDisplayName(
    trx: Transaction<DB>,
    userId: string,
    displayName: string,
  ): Promise<{ changed: boolean; changedAt: Date } | null> {
    const updated = await trx
      .updateTable('identity.users')
      .set({ displayName })
      .where('id', '=', userId)
      .where('displayName', '<>', displayName)
      .returning(sql<Date>`now()`.as('changedAt'))
      .executeTakeFirst();
    if (updated !== undefined) return { changed: true, changedAt: updated.changedAt };
    const exists = await trx
      .selectFrom('identity.users')
      .select(sql<Date>`now()`.as('now'))
      .where('id', '=', userId)
      .executeTakeFirst();
    return exists === undefined ? null : { changed: false, changedAt: exists.now };
  }

  async lockUser(trx: Transaction<DB>, userId: string): Promise<boolean> {
    const row = await trx
      .selectFrom('identity.users')
      .select('id')
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row !== undefined;
  }

  async lockUserShared(trx: Transaction<DB>, userId: string): Promise<boolean> {
    const row = await trx
      .selectFrom('identity.users')
      .select('id')
      .where('id', '=', userId)
      .forShare()
      .executeTakeFirst();
    return row !== undefined;
  }
}
