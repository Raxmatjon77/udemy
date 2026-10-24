import { z } from 'zod';
import { LectureTypeSchema } from '../http/catalog';
import {
  CertificateTransitionCauseSchema,
  isCompletionCauseAllowed,
  LectureCompletionCauseSchema,
} from '../http/learning';
import { defineEvent, type EventPayload } from './define-event';
import { eventId, eventTimestamp } from './payload-fields';

/**
 * Learning events (Phase 5 learning experience design §7). Payloads carry ids, enums and scores
 * only: no user-authored text and no names, so the topics use broker-default retention.
 *
 * - `learning.progress` (aggregateId = **userId**): a learner's completions and attempts stay
 *   ordered on one partition. Written in the request transaction (D2: completions are
 *   synchronous).
 * - `learning.certificate` (aggregateId = certificateId): written by the worker.
 */
export const LEARNING_PROGRESS_AGGREGATE = 'learning.progress';
export const LEARNING_CERTIFICATE_AGGREGATE = 'learning.certificate';

const progressOptions = { aggregateType: LEARNING_PROGRESS_AGGREGATE } as const;
const certificateOptions = { aggregateType: LEARNING_CERTIFICATE_AGGREGATE } as const;

/* ----------------------------------------------------------------------------------------
 * learning.progress
 * -------------------------------------------------------------------------------------- */

/** No consumer in Phase 5 (P6 analytics). The cause matches the lecture type (D4). */
export const LectureCompleted = defineEvent(
  'LectureCompleted',
  1,
  z
    .object({
      userId: eventId(),
      courseId: eventId(),
      lectureId: eventId(),
      lectureType: LectureTypeSchema,
      revisionId: eventId(),
      cause: LectureCompletionCauseSchema,
      completedAt: eventTimestamp(),
    })
    .refine((p) => isCompletionCauseAllowed(p.lectureType, p.cause), {
      message: 'The cause does not match the lecture type',
      path: ['cause'],
    }),
  progressOptions,
);

/** A learner un-ticked a lecture; never touches the course completion or a certificate. */
export const LectureCompletionCleared = defineEvent(
  'LectureCompletionCleared',
  1,
  z.object({
    userId: eventId(),
    courseId: eventId(),
    lectureId: eventId(),
    clearedAt: eventTimestamp(),
  }),
  progressOptions,
);

/** Completed ⊇ live lecture ids for the first time (D5). Consumed by the certificate issuer. */
export const CourseCompleted = defineEvent(
  'CourseCompleted',
  1,
  z.object({
    userId: eventId(),
    courseId: eventId(),
    revisionId: eventId(),
    lectureCount: z.number().int().min(1),
    completedAt: eventTimestamp(),
  }),
  progressOptions,
);

/** No consumer in Phase 5 (P6). A pass also writes `LectureCompleted` (QUIZ_PASSED). */
export const QuizAttemptGraded = defineEvent(
  'QuizAttemptGraded',
  1,
  z.object({
    attemptId: eventId(),
    userId: eventId(),
    courseId: eventId(),
    lectureId: eventId(),
    revisionId: eventId(),
    scorePct: z.number().int().min(0).max(100),
    passed: z.boolean(),
    gradedAt: eventTimestamp(),
  }),
  progressOptions,
);

/** Every v1 event on the `learning.progress` topic. */
export const LEARNING_PROGRESS_EVENTS = [
  LectureCompleted,
  LectureCompletionCleared,
  CourseCompleted,
  QuizAttemptGraded,
] as const;

/* ----------------------------------------------------------------------------------------
 * learning.certificate (written by the worker, D7)
 * -------------------------------------------------------------------------------------- */

const certificateFields = {
  certificateId: eventId(),
  userId: eventId(),
  courseId: eventId(),
  /** Set exactly for ADMIN transitions. */
  actorId: eventId().nullable(),
};

function actorMatchesCause(p: { cause: string; actorId: string | null }): boolean {
  return (p.cause === 'ADMIN') === (p.actorId !== null);
}
const ACTOR_RULE = { message: 'actorId is set exactly for ADMIN transitions', path: ['actorId'] };

/** Consumed by `notifications.certificate-notifier`. */
export const CertificateIssued = defineEvent(
  'CertificateIssued',
  1,
  z
    .object({
      ...certificateFields,
      cause: z.literal('COURSE_COMPLETED'),
      issuedAt: eventTimestamp(),
    })
    .refine(actorMatchesCause, ACTOR_RULE),
  certificateOptions,
);

/** On any `EnrollmentRevoked` (decision P5-D7), or by an admin with a reason. */
export const CertificateRevoked = defineEvent(
  'CertificateRevoked',
  1,
  z
    .object({
      ...certificateFields,
      cause: CertificateTransitionCauseSchema.extract(['ENROLLMENT_REVOKED', 'ADMIN']),
      revokedAt: eventTimestamp(),
    })
    .refine(actorMatchesCause, ACTOR_RULE),
  certificateOptions,
);

/** On a regrant while the course completion still exists, or by an admin with a reason. */
export const CertificateReinstated = defineEvent(
  'CertificateReinstated',
  1,
  z
    .object({
      ...certificateFields,
      cause: CertificateTransitionCauseSchema.extract(['ENROLLMENT_REGRANTED', 'ADMIN']),
      reinstatedAt: eventTimestamp(),
    })
    .refine(actorMatchesCause, ACTOR_RULE),
  certificateOptions,
);

/** Every v1 event on the `learning.certificate` topic. */
export const LEARNING_CERTIFICATE_EVENTS = [
  CertificateIssued,
  CertificateRevoked,
  CertificateReinstated,
] as const;

export type LectureCompletedPayload = EventPayload<typeof LectureCompleted>;
export type LectureCompletionClearedPayload = EventPayload<typeof LectureCompletionCleared>;
export type CourseCompletedPayload = EventPayload<typeof CourseCompleted>;
export type QuizAttemptGradedPayload = EventPayload<typeof QuizAttemptGraded>;
export type CertificateIssuedPayload = EventPayload<typeof CertificateIssued>;
export type CertificateRevokedPayload = EventPayload<typeof CertificateRevoked>;
export type CertificateReinstatedPayload = EventPayload<typeof CertificateReinstated>;
