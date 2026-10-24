import { MODERATION_STATUSES, type ModerationStatus } from '@udemy/contracts';
import { sql } from '@udemy/db';
import type { ReviewRecord } from '../domain/review';

/** Narrows a CHECK-constrained text column to its contract union (a mismatch is a bug: 500). */
export function narrow<T extends string>(values: readonly T[], value: string, column: string): T {
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Unexpected ${column} value "${value}"`);
}

export function moderationStatusOf(value: string, column: string): ModerationStatus {
  return narrow(MODERATION_STATUSES, value, column);
}

/**
 * A timestamptz column (`alias.column`, a trusted identifier) as exact ISO-8601 UTC text WITH
 * microseconds, for keyset cursors (P2 design §14: a JS Date keeps only milliseconds).
 */
export function exactUtcText(columnRef: string) {
  return sql<string>`to_char(${sql.ref(columnRef)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** A review joined with its live reply (`r` = reviews, `rr` = the live review_replies row). */
export interface ReviewJoinRow {
  id: string;
  courseId: string;
  userId: string;
  rating: number;
  body: string | null;
  moderationStatus: string;
  suspendedAt: Date | null;
  createdAt: Date;
  editedAt: Date | null;
  replyId: string | null;
  replyAuthorId: string | null;
  replyBody: string | null;
  replyModerationStatus: string | null;
  replyCreatedAt: Date | null;
  replyEditedAt: Date | null;
}

function replyOf(row: ReviewJoinRow): ReviewRecord['reply'] {
  const { replyId, replyAuthorId, replyBody, replyModerationStatus, replyCreatedAt } = row;
  if (
    replyId === null ||
    replyAuthorId === null ||
    replyBody === null ||
    replyModerationStatus === null ||
    replyCreatedAt === null
  ) {
    return null;
  }
  return {
    id: replyId,
    reviewId: row.id,
    authorId: replyAuthorId,
    body: replyBody,
    moderationStatus: moderationStatusOf(replyModerationStatus, 'review_replies.moderation_status'),
    createdAt: replyCreatedAt,
    editedAt: row.replyEditedAt,
  };
}

export function toReviewRecord(row: ReviewJoinRow): ReviewRecord {
  return {
    id: row.id,
    courseId: row.courseId,
    userId: row.userId,
    rating: row.rating,
    body: row.body,
    moderationStatus: moderationStatusOf(row.moderationStatus, 'reviews.moderation_status'),
    suspendedAt: row.suspendedAt,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    reply: replyOf(row),
  };
}
