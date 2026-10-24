import { Injectable } from '@nestjs/common';
import type { NotificationApp } from '@udemy/contracts';
import { type DB, sql, type Transaction } from '@udemy/db';

export interface CourseContext {
  readonly courseId: string;
  readonly ownerId: string;
  /** The live (published) revision's title, else the working copy's (5..60 characters). */
  readonly title: string;
}

export interface QuestionContext {
  readonly id: string;
  readonly courseId: string;
  readonly authorId: string;
  readonly title: string;
  /** Not deleted and VISIBLE. */
  readonly visible: boolean;
}

export interface AnswerContext {
  readonly id: string;
  readonly questionId: string;
  readonly authorId: string;
  readonly bodyMd: string;
  readonly visible: boolean;
}

export interface ReviewContext {
  readonly id: string;
  readonly courseId: string;
  readonly userId: string;
  readonly rating: number;
  readonly body: string | null;
  /** Counted and public: VISIBLE, not suspended, not deleted. */
  readonly published: boolean;
  readonly deleted: boolean;
}

export interface ReplyContext {
  readonly id: string;
  readonly reviewId: string;
  readonly authorId: string;
  readonly body: string;
  readonly visible: boolean;
}

export interface AnnouncementContext {
  readonly id: string;
  readonly courseId: string;
  readonly authorId: string;
  readonly title: string;
  readonly deleted: boolean;
}

export interface CertificateContext {
  readonly id: string;
  readonly userId: string;
  readonly courseId: string;
  readonly publicCode: string;
  readonly courseTitle: string;
  readonly status: 'ACTIVE' | 'REVOKED';
}

/** Which bell an author's notice goes to: the course owner works in the instructor app. */
export function appOfParticipant(userId: string, courseOwnerId: string): NotificationApp {
  return userId === courseOwnerId ? 'INSTRUCTOR' : 'STUDENT';
}

/**
 * The texts and ids notifiers snapshot into payloads (events carry ids only, design §7). Read
 * in the handler's transaction; null when the row is gone.
 */
@Injectable()
export class NotificationContextReader {
  async course(trx: Transaction<DB>, courseId: string): Promise<CourseContext | null> {
    const row = await trx
      .selectFrom('catalog.courses as c')
      .leftJoin('catalog.courseRevisions as r', 'r.id', 'c.publishedRevisionId')
      .select(['c.id', 'c.ownerId', 'c.title as courseTitle', 'r.title as revisionTitle'])
      .where('c.id', '=', courseId)
      .executeTakeFirst();
    return row === undefined
      ? null
      : { courseId: row.id, ownerId: row.ownerId, title: row.revisionTitle ?? row.courseTitle };
  }

  async displayName(trx: Transaction<DB>, userId: string): Promise<string | null> {
    const row = await trx
      .selectFrom('identity.users')
      .select('displayName')
      .where('id', '=', userId)
      .executeTakeFirst();
    return row?.displayName ?? null;
  }

  async question(trx: Transaction<DB>, id: string): Promise<QuestionContext | null> {
    const row = await trx
      .selectFrom('engagement.questions')
      .select(['id', 'courseId', 'authorId', 'title', 'moderationStatus', 'deletedAt'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          id: row.id,
          courseId: row.courseId,
          authorId: row.authorId,
          title: row.title,
          visible: row.deletedAt === null && row.moderationStatus === 'VISIBLE',
        };
  }

  async answer(trx: Transaction<DB>, id: string): Promise<AnswerContext | null> {
    const row = await trx
      .selectFrom('engagement.answers')
      .select(['id', 'questionId', 'authorId', 'bodyMd', 'moderationStatus', 'deletedAt'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          id: row.id,
          questionId: row.questionId,
          authorId: row.authorId,
          bodyMd: row.bodyMd,
          visible: row.deletedAt === null && row.moderationStatus === 'VISIBLE',
        };
  }

  /** Every answer of a question, any state (redaction of answers that quote its title). */
  async answerIdsOf(trx: Transaction<DB>, questionId: string): Promise<string[]> {
    const rows = await trx
      .selectFrom('engagement.answers')
      .select('id')
      .where('questionId', '=', questionId)
      .execute();
    return rows.map((r) => r.id);
  }

  async review(trx: Transaction<DB>, id: string): Promise<ReviewContext | null> {
    const row = await trx
      .selectFrom('engagement.reviews')
      .select([
        'id',
        'courseId',
        'userId',
        'rating',
        'body',
        'moderationStatus',
        'suspendedAt',
        'deletedAt',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          id: row.id,
          courseId: row.courseId,
          userId: row.userId,
          rating: row.rating,
          body: row.body,
          published:
            row.deletedAt === null &&
            row.suspendedAt === null &&
            row.moderationStatus === 'VISIBLE',
          deleted: row.deletedAt !== null,
        };
  }

  /** The live (not deleted) reply of a review. */
  async liveReply(trx: Transaction<DB>, reviewId: string): Promise<ReplyContext | null> {
    const row = await trx
      .selectFrom('engagement.reviewReplies')
      .select(['id', 'reviewId', 'authorId', 'body', 'moderationStatus'])
      .where('reviewId', '=', reviewId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          id: row.id,
          reviewId: row.reviewId,
          authorId: row.authorId,
          body: row.body,
          visible: row.moderationStatus === 'VISIBLE',
        };
  }

  /** Every reply of a review, deleted ones included (redaction). */
  async replyIdsOf(trx: Transaction<DB>, reviewId: string): Promise<string[]> {
    const rows = await trx
      .selectFrom('engagement.reviewReplies')
      .select('id')
      .where('reviewId', '=', reviewId)
      .execute();
    return rows.map((r) => r.id);
  }

  /**
   * The announcement, optionally locked `FOR SHARE`: the FanoutJob holds it while it inserts a
   * batch, so a concurrent delete (api) waits for the batch and the moderation notifier's
   * redaction then sees every row of it.
   */
  async announcement(
    trx: Transaction<DB>,
    id: string,
    options: { forShare?: boolean } = {},
  ): Promise<AnnouncementContext | null> {
    let query = trx
      .selectFrom('engagement.announcements')
      .select(['id', 'courseId', 'authorId', 'title', 'deletedAt'])
      .where('id', '=', id);
    if (options.forShare === true) query = query.forShare();
    const row = await query.executeTakeFirst();
    return row === undefined
      ? null
      : {
          id: row.id,
          courseId: row.courseId,
          authorId: row.authorId,
          title: row.title,
          deleted: row.deletedAt !== null,
        };
  }

  async certificate(trx: Transaction<DB>, id: string): Promise<CertificateContext | null> {
    const row = await trx
      .selectFrom('learning.certificates')
      .select(['id', 'userId', 'courseId', 'publicCode', 'courseTitle', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined
      ? null
      : { ...row, status: row.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE' };
  }

  async assetFilename(trx: Transaction<DB>, assetId: string): Promise<string | null> {
    const row = await trx
      .selectFrom('media.assets')
      .select('originalFilename')
      .where('id', '=', assetId)
      .executeTakeFirst();
    return row?.originalFilename ?? null;
  }

  /** All reports ever filed on a subject (the auto-hide threshold resolved them to ACTIONED). */
  async reportCount(
    trx: Transaction<DB>,
    subjectType: 'REVIEW' | 'REVIEW_REPLY' | 'QUESTION' | 'ANSWER',
    subjectId: string,
  ): Promise<number> {
    const table = {
      REVIEW: 'engagement.review_reports',
      REVIEW_REPLY: 'engagement.review_reply_reports',
      QUESTION: 'engagement.question_reports',
      ANSWER: 'engagement.answer_reports',
    }[subjectType];
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE subject_id = ${subjectId}
    `.execute(trx);
    return rows[0]?.n ?? 0;
  }
}
