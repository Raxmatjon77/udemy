import { z } from 'zod';
import { defineEvent, type EventPayload } from './define-event';
import { eventId, eventTimestamp } from './payload-fields';

/**
 * Engagement events (Phase 5 learning experience design §7). Payloads carry ids, ratings and
 * enums only: **no user-authored text and no names** (consumers read text through worker
 * readers), so moderation and deletion are never undercut by a log and the topics use
 * broker-default retention.
 *
 * Every topic is keyed by **courseId**, so a course's events are ordered on one partition (the
 * rating aggregator recomputes per course, D11).
 *
 * `actorId` null = AUTO (the report threshold, D13) on `…Hidden`; otherwise the author or admin.
 */
export const ENGAGEMENT_COURSE_REVIEW_AGGREGATE = 'engagement.course_review';
export const ENGAGEMENT_QUESTION_AGGREGATE = 'engagement.question';
export const ENGAGEMENT_ANNOUNCEMENT_AGGREGATE = 'engagement.announcement';

const reviewOptions = { aggregateType: ENGAGEMENT_COURSE_REVIEW_AGGREGATE } as const;
const questionOptions = { aggregateType: ENGAGEMENT_QUESTION_AGGREGATE } as const;
const announcementOptions = { aggregateType: ENGAGEMENT_ANNOUNCEMENT_AGGREGATE } as const;

const rating = () => z.number().int().min(1).max(5);

/* ----------------------------------------------------------------------------------------
 * engagement.course_review
 * -------------------------------------------------------------------------------------- */

/** Consumed by the rating aggregator and the review notifier. */
export const ReviewPosted = defineEvent(
  'ReviewPosted',
  1,
  z.object({
    reviewId: eventId(),
    courseId: eventId(),
    userId: eventId(),
    rating: rating(),
    /** Always null for a new review (kept for symmetry with `ReviewEdited`). */
    previousRating: z.null(),
    postedAt: eventTimestamp(),
  }),
  reviewOptions,
);

/** The notifier only notifies when `rating !== previousRating`. */
export const ReviewEdited = defineEvent(
  'ReviewEdited',
  1,
  z.object({
    reviewId: eventId(),
    courseId: eventId(),
    userId: eventId(),
    rating: rating(),
    previousRating: rating(),
    editedAt: eventTimestamp(),
  }),
  reviewOptions,
);

const reviewModerationFields = {
  reviewId: eventId(),
  courseId: eventId(),
  actorId: eventId().nullable(),
};

/** Soft delete by the author or an admin (a new review may follow). */
export const ReviewDeleted = defineEvent(
  'ReviewDeleted',
  1,
  z.object({ ...reviewModerationFields, actorId: eventId(), deletedAt: eventTimestamp() }),
  reviewOptions,
);

export const ReviewHidden = defineEvent(
  'ReviewHidden',
  1,
  z.object({ ...reviewModerationFields, hiddenAt: eventTimestamp() }),
  reviewOptions,
);

/** Admin restore (dismisses the open reports). */
export const ReviewRestored = defineEvent(
  'ReviewRestored',
  1,
  z.object({ ...reviewModerationFields, actorId: eventId(), restoredAt: eventTimestamp() }),
  reviewOptions,
);

const replyFields = {
  reviewId: eventId(),
  courseId: eventId(),
  /** The reply author (the course owner). */
  authorId: eventId(),
};

/** Consumed by the review notifier (notifies the reviewer). */
export const ReviewReplyPosted = defineEvent(
  'ReviewReplyPosted',
  1,
  z.object({ ...replyFields, postedAt: eventTimestamp() }),
  reviewOptions,
);

export const ReviewReplyEdited = defineEvent(
  'ReviewReplyEdited',
  1,
  z.object({ ...replyFields, editedAt: eventTimestamp() }),
  reviewOptions,
);

export const ReviewReplyDeleted = defineEvent(
  'ReviewReplyDeleted',
  1,
  z.object({ ...replyFields, deletedAt: eventTimestamp() }),
  reviewOptions,
);

/** Consumed by the moderation notifier (redacts `REVIEW_REPLY` notifications). */
export const ReviewReplyHidden = defineEvent(
  'ReviewReplyHidden',
  1,
  z.object({ ...replyFields, actorId: eventId().nullable(), hiddenAt: eventTimestamp() }),
  reviewOptions,
);

/** Admin restore of a hidden reply (the admin route exists for every report subject). */
export const ReviewReplyRestored = defineEvent(
  'ReviewReplyRestored',
  1,
  z.object({ ...replyFields, actorId: eventId(), restoredAt: eventTimestamp() }),
  reviewOptions,
);

/** Every v1 event on the `engagement.course_review` topic. */
export const ENGAGEMENT_COURSE_REVIEW_EVENTS = [
  ReviewPosted,
  ReviewEdited,
  ReviewDeleted,
  ReviewHidden,
  ReviewRestored,
  ReviewReplyPosted,
  ReviewReplyEdited,
  ReviewReplyDeleted,
  ReviewReplyHidden,
  ReviewReplyRestored,
] as const;

/* ----------------------------------------------------------------------------------------
 * engagement.question
 * -------------------------------------------------------------------------------------- */

/** Consumed by the Q&A notifier (notifies the course owner). */
export const QuestionPosted = defineEvent(
  'QuestionPosted',
  1,
  z.object({
    questionId: eventId(),
    courseId: eventId(),
    lectureId: eventId().nullable(),
    authorId: eventId(),
    postedAt: eventTimestamp(),
  }),
  questionOptions,
);

/** Notifies the question author unless they wrote the answer. */
export const AnswerPosted = defineEvent(
  'AnswerPosted',
  1,
  z.object({
    answerId: eventId(),
    questionId: eventId(),
    courseId: eventId(),
    authorId: eventId(),
    questionAuthorId: eventId(),
    /** The answer author owns the course ("instructor answered"). */
    byCourseOwner: z.boolean(),
    postedAt: eventTimestamp(),
  }),
  questionOptions,
);

/** An answer was accepted by the question author or the course owner. */
export const QuestionResolved = defineEvent(
  'QuestionResolved',
  1,
  z.object({
    questionId: eventId(),
    courseId: eventId(),
    answerId: eventId(),
    actorId: eventId(),
    resolvedAt: eventTimestamp(),
  }),
  questionOptions,
);

/**
 * The accepted answer was un-accepted (`actorId` set) or deleted/hidden (`actorId` of that
 * action, null for an AUTO hide). `answerId` is the previously accepted answer.
 */
export const QuestionReopened = defineEvent(
  'QuestionReopened',
  1,
  z.object({
    questionId: eventId(),
    courseId: eventId(),
    answerId: eventId().nullable(),
    actorId: eventId().nullable(),
    reopenedAt: eventTimestamp(),
  }),
  questionOptions,
);

const questionSubject = { questionId: eventId(), courseId: eventId() };
const answerSubject = { answerId: eventId(), questionId: eventId(), courseId: eventId() };

export const QuestionHidden = defineEvent(
  'QuestionHidden',
  1,
  z.object({ ...questionSubject, actorId: eventId().nullable(), hiddenAt: eventTimestamp() }),
  questionOptions,
);

export const QuestionRestored = defineEvent(
  'QuestionRestored',
  1,
  z.object({ ...questionSubject, actorId: eventId(), restoredAt: eventTimestamp() }),
  questionOptions,
);

/** By the author (or an admin); a question with answers keeps a "[deleted]" placeholder. */
export const QuestionDeleted = defineEvent(
  'QuestionDeleted',
  1,
  z.object({ ...questionSubject, actorId: eventId(), deletedAt: eventTimestamp() }),
  questionOptions,
);

export const AnswerHidden = defineEvent(
  'AnswerHidden',
  1,
  z.object({ ...answerSubject, actorId: eventId().nullable(), hiddenAt: eventTimestamp() }),
  questionOptions,
);

export const AnswerRestored = defineEvent(
  'AnswerRestored',
  1,
  z.object({ ...answerSubject, actorId: eventId(), restoredAt: eventTimestamp() }),
  questionOptions,
);

export const AnswerDeleted = defineEvent(
  'AnswerDeleted',
  1,
  z.object({ ...answerSubject, actorId: eventId(), deletedAt: eventTimestamp() }),
  questionOptions,
);

/** Every v1 event on the `engagement.question` topic. */
export const ENGAGEMENT_QUESTION_EVENTS = [
  QuestionPosted,
  AnswerPosted,
  QuestionResolved,
  QuestionReopened,
  QuestionHidden,
  QuestionRestored,
  QuestionDeleted,
  AnswerHidden,
  AnswerRestored,
  AnswerDeleted,
] as const;

/* ----------------------------------------------------------------------------------------
 * engagement.announcement
 * -------------------------------------------------------------------------------------- */

const announcementFields = {
  announcementId: eventId(),
  courseId: eventId(),
  authorId: eventId(),
  sendEmail: z.boolean(),
};

/** Consumed by the fan-out enqueuer (`notifications.fanout_jobs`, D18). */
export const AnnouncementPosted = defineEvent(
  'AnnouncementPosted',
  1,
  z.object({ ...announcementFields, postedAt: eventTimestamp() }),
  announcementOptions,
);

/** Consumed by the moderation notifier (redacts the ANNOUNCEMENT notifications). */
export const AnnouncementDeleted = defineEvent(
  'AnnouncementDeleted',
  1,
  z.object({ ...announcementFields, actorId: eventId(), deletedAt: eventTimestamp() }),
  announcementOptions,
);

/** Every v1 event on the `engagement.announcement` topic. */
export const ENGAGEMENT_ANNOUNCEMENT_EVENTS = [AnnouncementPosted, AnnouncementDeleted] as const;

export type ReviewPostedPayload = EventPayload<typeof ReviewPosted>;
export type ReviewEditedPayload = EventPayload<typeof ReviewEdited>;
export type ReviewDeletedPayload = EventPayload<typeof ReviewDeleted>;
export type ReviewHiddenPayload = EventPayload<typeof ReviewHidden>;
export type ReviewRestoredPayload = EventPayload<typeof ReviewRestored>;
export type ReviewReplyPostedPayload = EventPayload<typeof ReviewReplyPosted>;
export type ReviewReplyEditedPayload = EventPayload<typeof ReviewReplyEdited>;
export type ReviewReplyDeletedPayload = EventPayload<typeof ReviewReplyDeleted>;
export type ReviewReplyHiddenPayload = EventPayload<typeof ReviewReplyHidden>;
export type ReviewReplyRestoredPayload = EventPayload<typeof ReviewReplyRestored>;
export type QuestionPostedPayload = EventPayload<typeof QuestionPosted>;
export type AnswerPostedPayload = EventPayload<typeof AnswerPosted>;
export type QuestionResolvedPayload = EventPayload<typeof QuestionResolved>;
export type QuestionReopenedPayload = EventPayload<typeof QuestionReopened>;
export type QuestionHiddenPayload = EventPayload<typeof QuestionHidden>;
export type QuestionRestoredPayload = EventPayload<typeof QuestionRestored>;
export type QuestionDeletedPayload = EventPayload<typeof QuestionDeleted>;
export type AnswerHiddenPayload = EventPayload<typeof AnswerHidden>;
export type AnswerRestoredPayload = EventPayload<typeof AnswerRestored>;
export type AnswerDeletedPayload = EventPayload<typeof AnswerDeleted>;
export type AnnouncementPostedPayload = EventPayload<typeof AnnouncementPosted>;
export type AnnouncementDeletedPayload = EventPayload<typeof AnnouncementDeleted>;
