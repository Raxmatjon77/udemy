import { Injectable } from '@nestjs/common';
import { type DB, type Executor, lockWishlistCap, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type WishlistKeyset,
  WishlistRepository,
  type WishlistRow,
} from '../application/ports/wishlist.repository';
import { mapEngagementConstraints } from './engagement-constraint-errors';
import { exactUtcText } from './row-mapping';

/** `engagement.wishlist_items` through Kysely (insert/delete only; the cap via `@udemy/db`). */
@Injectable()
export class KyselyWishlistRepository extends WishlistRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async contains(userId: string, courseId: string, ex?: Executor): Promise<boolean> {
    const row = await (ex ?? this.db)
      .selectFrom('engagement.wishlistItems')
      .select(sql<number>`1`.as('one'))
      .where('userId', '=', userId)
      .where('courseId', '=', courseId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async lockCap(trx: Transaction<DB>, userId: string): Promise<number> {
    return (await lockWishlistCap(trx, userId)).itemCount;
  }

  async add(trx: Transaction<DB>, userId: string, courseId: string): Promise<boolean> {
    const result = await mapEngagementConstraints(() =>
      trx
        .insertInto('engagement.wishlistItems')
        .values({ userId, courseId })
        .onConflict((oc) => oc.columns(['userId', 'courseId']).doNothing())
        .executeTakeFirst(),
    );
    return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1;
  }

  async remove(userId: string, courseId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('engagement.wishlistItems')
      .where('userId', '=', userId)
      .where('courseId', '=', courseId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  }

  async listPage(
    userId: string,
    after: WishlistKeyset | null,
    limit: number,
  ): Promise<WishlistRow[]> {
    // Served by wishlist_items_user_id_added_at_course_id_idx (user_id, added_at DESC, course_id DESC).
    let query = this.db
      .selectFrom('engagement.wishlistItems as w')
      .select(['w.courseId', 'w.addedAt'])
      .select(exactUtcText('w.added_at').as('addedAtKey'))
      .where('w.userId', '=', userId);
    if (after !== null) {
      query = query.where(
        sql<boolean>`(w.added_at, w.course_id) < (${after.addedAt}::timestamptz, ${after.courseId}::uuid)`,
      );
    }
    return query.orderBy('w.addedAt', 'desc').orderBy('w.courseId', 'desc').limit(limit).execute();
  }

  async wishlistedAmong(
    userId: string,
    courseIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (courseIds.length === 0) return new Set();
    const rows = await this.db
      .selectFrom('engagement.wishlistItems')
      .select('courseId')
      .where('userId', '=', userId)
      .where('courseId', 'in', [...courseIds])
      .execute();
    return new Set(rows.map((r) => r.courseId));
  }
}
