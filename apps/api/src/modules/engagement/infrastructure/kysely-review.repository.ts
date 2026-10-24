import { Injectable } from '@nestjs/common';
import {
  type DB,
  type Executor,
  getCourseRatings,
  sql,
  type Transaction,
  upsertReview,
  upsertReviewReply,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type ReviewListFilter,
  type ReviewListRow,
  ReviewRepository,
  type SoftDeleted,
  type SoftDeletedReply,
  type UpsertReplyRecord,
  type UpsertReviewRecord,
} from '../application/ports/review.repository';
import type { CourseRatingStats, ReviewRecord } from '../domain/review';
import { mapEngagementConstraints } from './engagement-constraint-errors';
import { exactUtcText, toReviewRecord } from './row-mapping';

/**
 * `engagement.reviews` / `review_replies` / `course_rating_stats` through Kysely. The upserts
 * and the histogram read are the `@udemy/db` operational SQL (`engagement/reviews.ts`, the only
 * code that may touch `count_1..count_5`, which do not survive the CamelCasePlugin); the rows
 * are re-read in the same transaction for the events and the response (timestamps come from
 * SQL `now()`).
 */
@Injectable()
export class KyselyReviewRepository extends ReviewRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  /** Reviews joined with their LIVE reply (at most one, `review_replies_review_id_live_uq`). */
  private reviews(ex?: Executor) {
    return (ex ?? this.db)
      .selectFrom('engagement.reviews as r')
      .leftJoin('engagement.reviewReplies as rr', (join) =>
        join.onRef('rr.reviewId', '=', 'r.id').on('rr.deletedAt', 'is', null),
      )
      .select([
        'r.id',
        'r.courseId',
        'r.userId',
        'r.rating',
        'r.body',
        'r.moderationStatus',
        'r.suspendedAt',
        'r.createdAt',
        'r.editedAt',
        'rr.id as replyId',
        'rr.authorId as replyAuthorId',
        'rr.body as replyBody',
        'rr.moderationStatus as replyModerationStatus',
        'rr.createdAt as replyCreatedAt',
        'rr.editedAt as replyEditedAt',
      ])
      .where('r.deletedAt', 'is', null);
  }

  async getRatings(courseIds: readonly string[]): Promise<CourseRatingStats[]> {
    const ratings = await getCourseRatings(this.db, courseIds);
    return ratings.map((r) => ({
      courseId: r.courseId,
      reviewCount: r.reviewCount,
      average: r.average,
      counts: r.counts,
    }));
  }

  private async list(filter: ReviewListFilter, publishedOnly: boolean): Promise<ReviewListRow[]> {
    // Served by reviews_course_id_(rating_)created_at_id_public_idx (published) or
    // reviews_course_id_created_at_id_live_idx (every live review).
    let query = this.reviews()
      .select(exactUtcText('r.created_at').as('createdAtKey'))
      .where('r.courseId', '=', filter.courseId);
    if (publishedOnly) {
      query = query.where('r.moderationStatus', '=', 'VISIBLE').where('r.suspendedAt', 'is', null);
    }
    if (filter.rating !== undefined) query = query.where('r.rating', '=', filter.rating);
    if (filter.after !== null) {
      query = query.where(
        sql<boolean>`(r.created_at, r.id) < (${filter.after.createdAt}::timestamptz, ${filter.after.id}::uuid)`,
      );
    }
    const rows = await query
      .orderBy('r.createdAt', 'desc')
      .orderBy('r.id', 'desc')
      .limit(filter.limit)
      .execute();
    return rows.map((row) => ({ review: toReviewRecord(row), createdAtKey: row.createdAtKey }));
  }

  listPublished(filter: ReviewListFilter): Promise<ReviewListRow[]> {
    return this.list(filter, true);
  }

  listLive(filter: ReviewListFilter): Promise<ReviewListRow[]> {
    return this.list(filter, false);
  }

  async findLiveByUser(
    courseId: string,
    userId: string,
    ex?: Executor,
  ): Promise<ReviewRecord | null> {
    const row = await this.reviews(ex)
      .where('r.courseId', '=', courseId)
      .where('r.userId', '=', userId)
      .executeTakeFirst();
    return row === undefined ? null : toReviewRecord(row);
  }

  async findLiveById(reviewId: string, ex?: Executor): Promise<ReviewRecord | null> {
    const row = await this.reviews(ex).where('r.id', '=', reviewId).executeTakeFirst();
    return row === undefined ? null : toReviewRecord(row);
  }

  async upsert(
    trx: Transaction<DB>,
    input: { courseId: string; userId: string; rating: number; body: string | null },
  ): Promise<UpsertReviewRecord> {
    const result = await mapEngagementConstraints(() => upsertReview(trx, input));
    const review = await this.findLiveById(result.reviewId, trx);
    if (review === null) throw new Error(`upserted review ${result.reviewId} vanished`);
    return { outcome: result.outcome, previousRating: result.previousRating, review };
  }

  async softDeleteByUser(
    trx: Transaction<DB>,
    courseId: string,
    userId: string,
  ): Promise<SoftDeleted | null> {
    const row = await mapEngagementConstraints(() =>
      trx
        .updateTable('engagement.reviews')
        .set({ deletedAt: sql<Date>`now()`, deletedBy: userId })
        .where('courseId', '=', courseId)
        .where('userId', '=', userId)
        .where('deletedAt', 'is', null)
        .returning(['id', 'deletedAt'])
        .executeTakeFirst(),
    );
    if (row === undefined) return null;
    if (row.deletedAt === null) throw new Error(`review ${row.id} soft delete without deleted_at`);
    return { id: row.id, deletedAt: row.deletedAt };
  }

  async lockLiveInCourse(
    trx: Transaction<DB>,
    courseId: string,
    reviewId: string,
  ): Promise<ReviewRecord | null> {
    // FOR SHARE on the review row alone (a locking clause cannot cover the outer-joined reply).
    const locked = await trx
      .selectFrom('engagement.reviews')
      .select('id')
      .where('id', '=', reviewId)
      .where('courseId', '=', courseId)
      .where('deletedAt', 'is', null)
      .forShare()
      .executeTakeFirst();
    if (locked === undefined) return null;
    return this.findLiveById(locked.id, trx);
  }

  async upsertReply(
    trx: Transaction<DB>,
    input: { reviewId: string; authorId: string; body: string },
  ): Promise<UpsertReplyRecord> {
    const result = await mapEngagementConstraints(() => upsertReviewReply(trx, input));
    const review = await this.findLiveById(input.reviewId, trx);
    if (review === null) throw new Error(`review ${input.reviewId} vanished under its reply`);
    return { outcome: result.outcome, review };
  }

  async softDeleteReply(trx: Transaction<DB>, reviewId: string): Promise<SoftDeletedReply | null> {
    const row = await mapEngagementConstraints(() =>
      trx
        .updateTable('engagement.reviewReplies')
        .set({ deletedAt: sql<Date>`now()` })
        .where('reviewId', '=', reviewId)
        .where('deletedAt', 'is', null)
        .returning(['id', 'authorId', 'deletedAt'])
        .executeTakeFirst(),
    );
    if (row === undefined) return null;
    if (row.deletedAt === null) throw new Error(`reply ${row.id} soft delete without deleted_at`);
    return { id: row.id, authorId: row.authorId, deletedAt: row.deletedAt };
  }
}
