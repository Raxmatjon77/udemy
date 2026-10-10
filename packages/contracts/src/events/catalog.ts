import { z } from 'zod';
import { RevisionKindSchema } from '../http/catalog';
import { defineEvent, type EventPayload } from './define-event';
import { eventId, eventTimestamp } from './payload-fields';

/** Aggregate type and Kafka topic of every course event; aggregateId = courseId (design §7). */
export const CATALOG_COURSE_AGGREGATE = 'catalog.course';
const options = { aggregateType: CATALOG_COURSE_AGGREGATE } as const;

/** Lenient shape guards: the domain VOs already enforced the strict rules. */
const courseTitle = () => z.string().min(1).max(60);
const courseSlug = () => z.string().min(1).max(60);
const revisionNo = () => z.number().int().min(1);

export const WITHDRAWAL_CAUSES = ['OWNER', 'ARCHIVED'] as const;
export const WithdrawalCauseSchema = z.enum(WITHDRAWAL_CAUSES);
export type WithdrawalCause = z.infer<typeof WithdrawalCauseSchema>;

export const CourseCreated = defineEvent(
  'CourseCreated',
  1,
  z.object({
    courseId: eventId(),
    ownerId: eventId(),
    title: courseTitle(),
    createdAt: eventTimestamp(),
  }),
  options,
);

/** Consumed by the worker: mails every ADMIN a link to the review page. */
export const CourseSubmittedForReview = defineEvent(
  'CourseSubmittedForReview',
  1,
  z.object({
    courseId: eventId(),
    revisionId: eventId(),
    revisionNo: revisionNo(),
    ownerId: eventId(),
    kind: RevisionKindSchema,
    title: courseTitle(),
    submittedAt: eventTimestamp(),
  }),
  options,
);

/** `cause` ARCHIVED: archiving a published course auto-withdrew its pending update. */
export const CourseSubmissionWithdrawn = defineEvent(
  'CourseSubmissionWithdrawn',
  1,
  z.object({
    courseId: eventId(),
    revisionId: eventId(),
    ownerId: eventId(),
    actorId: eventId(),
    cause: WithdrawalCauseSchema,
    withdrawnAt: eventTimestamp(),
  }),
  options,
);

/** Consumed by the decision mailer; later by search, ISR revalidation and commerce. */
export const CoursePublished = defineEvent(
  'CoursePublished',
  1,
  z.object({
    courseId: eventId(),
    revisionId: eventId(),
    revisionNo: revisionNo(),
    ownerId: eventId(),
    slug: courseSlug(),
    kind: RevisionKindSchema,
    decidedBy: eventId(),
    publishedAt: eventTimestamp(),
  }),
  options,
);

/** The reason is mailed to the instructor. */
export const CourseRejected = defineEvent(
  'CourseRejected',
  1,
  z.object({
    courseId: eventId(),
    revisionId: eventId(),
    ownerId: eventId(),
    kind: RevisionKindSchema,
    decidedBy: eventId(),
    reason: z.string().min(10).max(2000),
    rejectedAt: eventTimestamp(),
  }),
  options,
);

/** `byAdmin` = takedown (reason required, mailed to the instructor); else owner archive. */
export const CourseArchived = defineEvent(
  'CourseArchived',
  1,
  z
    .object({
      courseId: eventId(),
      ownerId: eventId(),
      actorId: eventId(),
      byAdmin: z.boolean(),
      reason: z.string().min(1).max(2000).nullable(),
      archivedAt: eventTimestamp(),
    })
    .refine((p) => !p.byAdmin || (p.reason !== null && p.reason.length >= 10), {
      message: 'An admin takedown requires a reason of at least 10 characters',
      path: ['reason'],
    }),
  options,
);

export const CourseRestored = defineEvent(
  'CourseRestored',
  1,
  z.object({
    courseId: eventId(),
    ownerId: eventId(),
    actorId: eventId(),
    restoredAt: eventTimestamp(),
  }),
  options,
);

export const CourseDeleted = defineEvent(
  'CourseDeleted',
  1,
  z.object({
    courseId: eventId(),
    ownerId: eventId(),
    deletedAt: eventTimestamp(),
  }),
  options,
);

/** Every v1 event on the `catalog.course` topic. */
export const CATALOG_COURSE_EVENTS = [
  CourseCreated,
  CourseSubmittedForReview,
  CourseSubmissionWithdrawn,
  CoursePublished,
  CourseRejected,
  CourseArchived,
  CourseRestored,
  CourseDeleted,
] as const;

export type CourseCreatedPayload = EventPayload<typeof CourseCreated>;
export type CourseSubmittedForReviewPayload = EventPayload<typeof CourseSubmittedForReview>;
export type CourseSubmissionWithdrawnPayload = EventPayload<typeof CourseSubmissionWithdrawn>;
export type CoursePublishedPayload = EventPayload<typeof CoursePublished>;
export type CourseRejectedPayload = EventPayload<typeof CourseRejected>;
export type CourseArchivedPayload = EventPayload<typeof CourseArchived>;
export type CourseRestoredPayload = EventPayload<typeof CourseRestored>;
export type CourseDeletedPayload = EventPayload<typeof CourseDeleted>;
