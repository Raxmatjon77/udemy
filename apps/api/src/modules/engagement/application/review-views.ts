import type {
  InstructorReview,
  MyReview,
  PersonRef,
  PublicReview,
  PublicReviewReply,
  ReviewReply,
} from '@udemy/contracts';
import {
  publicReplyOf,
  type ReviewRecord,
  type ReviewReplyRecord,
  reviewState,
} from '../domain/review';
import { personOf } from './people';

type People = ReadonlyMap<string, PersonRef>;

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** Every author a list of reviews mentions (reviewers and reply authors). */
export function reviewAuthorIds(reviews: readonly ReviewRecord[]): string[] {
  return reviews.flatMap((r) => (r.reply === null ? [r.userId] : [r.userId, r.reply.authorId]));
}

function toPublicReply(reply: ReviewReplyRecord | null, people: People): PublicReviewReply | null {
  return reply === null
    ? null
    : {
        body: reply.body,
        author: personOf(people, reply.authorId),
        createdAt: iso(reply.createdAt),
        editedAt: isoOrNull(reply.editedAt),
      };
}

export function toPublicReview(review: ReviewRecord, people: People): PublicReview {
  return {
    id: review.id,
    rating: review.rating,
    body: review.body,
    author: personOf(people, review.userId),
    createdAt: iso(review.createdAt),
    editedAt: isoOrNull(review.editedAt),
    reply: toPublicReply(publicReplyOf(review), people),
  };
}

export function toMyReview(review: ReviewRecord, people: People): MyReview {
  return {
    id: review.id,
    courseId: review.courseId,
    rating: review.rating,
    body: review.body,
    state: reviewState(review),
    createdAt: iso(review.createdAt),
    editedAt: isoOrNull(review.editedAt),
    reply: toPublicReply(publicReplyOf(review), people),
  };
}

export function toReviewReply(
  reviewId: string,
  reply: ReviewReplyRecord,
  people: People,
): ReviewReply {
  return {
    reviewId,
    body: reply.body,
    author: personOf(people, reply.authorId),
    hidden: reply.moderationStatus === 'HIDDEN',
    createdAt: iso(reply.createdAt),
    editedAt: isoOrNull(reply.editedAt),
  };
}

export function toInstructorReview(review: ReviewRecord, people: People): InstructorReview {
  return {
    id: review.id,
    courseId: review.courseId,
    rating: review.rating,
    body: review.body,
    author: personOf(people, review.userId),
    state: reviewState(review),
    createdAt: iso(review.createdAt),
    editedAt: isoOrNull(review.editedAt),
    reply: review.reply === null ? null : toReviewReply(review.id, review.reply, people),
  };
}
