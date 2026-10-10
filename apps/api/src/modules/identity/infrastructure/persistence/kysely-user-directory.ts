import { Injectable } from '@nestjs/common';
import { type Executor, sql } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type { UserSummary } from '../../application/dto';
import {
  UserDirectory,
  type UserSearchFilter,
  type UserSearchRow,
} from '../../application/ports/user-directory';

/** `created_at` as UTC ISO 8601 with microseconds (keyset cursors must not lose precision). */
const CREATED_AT_TEXT = sql<string>`to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

@Injectable()
export class KyselyUserDirectory extends UserDirectory {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  private base(ex: Executor) {
    return ex.selectFrom('identity.users as u').select((eb) => [
      'u.id',
      'u.email',
      'u.displayName',
      'u.emailVerifiedAt',
      'u.createdAt',
      CREATED_AT_TEXT.as('createdAtText'),
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

  async findSummaries(userIds: readonly string[], ex: Executor = this.db): Promise<UserSummary[]> {
    if (userIds.length === 0) return [];
    const rows = await this.base(ex)
      .where('u.id', 'in', [...userIds])
      .execute();
    return rows.map(toSummary);
  }

  async search(filter: UserSearchFilter, ex: Executor = this.db): Promise<UserSearchRow[]> {
    let query = this.base(ex);
    if (filter.pattern !== undefined) {
      const pattern = filter.pattern;
      // `email::text` exactly as in users_email_trgm_idx, so the trigram index applies.
      query = query.where((eb) =>
        eb.or([
          eb('u.displayName', 'ilike', pattern),
          eb(sql<string>`u.email::text`, 'ilike', pattern),
        ]),
      );
    }
    if (filter.status !== undefined) {
      const banned = filter.status === 'BANNED';
      query = query.where((eb) => {
        const activeBan = eb.exists(
          eb
            .selectFrom('identity.userBans as b')
            .select(sql.lit(1).as('one'))
            .whereRef('b.userId', '=', 'u.id')
            .where('b.liftedAt', 'is', null),
        );
        return banned ? activeBan : eb.not(activeBan);
      });
    }
    if (filter.idIn !== undefined) {
      query = query.where('u.id', '=', sql<string>`any(${sql.val([...filter.idIn])}::uuid[])`);
    }
    if (filter.after !== undefined) {
      const { createdAt, id } = filter.after;
      query = query.where(
        sql<boolean>`(u.created_at, u.id) < (${createdAt}::timestamptz, ${id}::uuid)`,
      );
    }
    const rows = await query
      .orderBy('u.createdAt', 'desc')
      .orderBy('u.id', 'desc')
      .limit(filter.take)
      .execute();
    return rows.map((row) => ({
      summary: toSummary(row),
      keyset: { createdAt: row.createdAtText, id: row.id },
    }));
  }
}

function toSummary(row: {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  banned: boolean;
}): UserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    emailVerified: row.emailVerifiedAt !== null,
    status: row.banned ? 'BANNED' : 'ACTIVE',
    createdAt: row.createdAt,
  };
}
