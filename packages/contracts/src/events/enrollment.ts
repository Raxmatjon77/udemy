import { z } from 'zod';
import { EnrollmentRevokeReasonSchema, EnrollmentSourceSchema } from '../http/enrollment';
import { defineEvent, type EventPayload } from './define-event';
import { eventId, eventTimestamp } from './payload-fields';

/**
 * Enrollment events (Phase 4 design §7). Written in the same transaction as the grant or
 * revoke (D8); aggregateId = enrollmentId.
 */
export const ENROLLMENT_ENROLLMENT_AGGREGATE = 'enrollment.enrollment';
const options = { aggregateType: ENROLLMENT_ENROLLMENT_AGGREGATE } as const;

/**
 * Not emitted for ALREADY_ACTIVE. `regrant` = a REVOKED enrollment became ACTIVE again.
 * Consumed by `enrollment.instructor-new-enrollment-mailer` (flagged off) and Phase 5 learning.
 */
export const EnrollmentGranted = defineEvent(
  'EnrollmentGranted',
  1,
  z
    .object({
      enrollmentId: eventId(),
      userId: eventId(),
      courseId: eventId(),
      source: EnrollmentSourceSchema,
      orderLineId: eventId().nullable(),
      regrant: z.boolean(),
      grantedAt: eventTimestamp(),
    })
    .refine((p) => (p.source === 'ORDER') === (p.orderLineId !== null), {
      message: 'orderLineId is set exactly for ORDER enrollments',
      path: ['orderLineId'],
    }),
  options,
);

/** `refundId` is required for a REFUND revoke; `actorId` for an ADMIN revoke. */
export const EnrollmentRevoked = defineEvent(
  'EnrollmentRevoked',
  1,
  z
    .object({
      enrollmentId: eventId(),
      userId: eventId(),
      courseId: eventId(),
      reason: EnrollmentRevokeReasonSchema,
      refundId: eventId().nullable(),
      actorId: eventId().nullable(),
      revokedAt: eventTimestamp(),
    })
    .refine((p) => p.reason !== 'REFUND' || p.refundId !== null, {
      message: 'A REFUND revoke carries the refundId',
      path: ['refundId'],
    })
    .refine((p) => p.reason !== 'ADMIN' || p.actorId !== null, {
      message: 'An ADMIN revoke carries the actorId',
      path: ['actorId'],
    }),
  options,
);

/** Every v1 event on the `enrollment.enrollment` topic. */
export const ENROLLMENT_ENROLLMENT_EVENTS = [EnrollmentGranted, EnrollmentRevoked] as const;

export type EnrollmentGrantedPayload = EventPayload<typeof EnrollmentGranted>;
export type EnrollmentRevokedPayload = EventPayload<typeof EnrollmentRevoked>;
