import { z } from 'zod';
import { defineEvent, type EventPayload } from './define-event';
import { eventId, eventTimestamp } from './payload-fields';

/** Aggregate type and Kafka topic of instructor application events; aggregateId = applicationId. */
export const USERS_INSTRUCTOR_APPLICATION_AGGREGATE = 'users.instructor_application';
const options = { aggregateType: USERS_INSTRUCTOR_APPLICATION_AGGREGATE } as const;

export const InstructorApplicationSubmitted = defineEvent(
  'InstructorApplicationSubmitted',
  1,
  z.object({
    applicationId: eventId(),
    applicantId: eventId(),
    submittedAt: eventTimestamp(),
  }),
  options,
);

export const InstructorApplicationApproved = defineEvent(
  'InstructorApplicationApproved',
  1,
  z.object({
    applicationId: eventId(),
    applicantId: eventId(),
    decidedBy: eventId(),
    decidedAt: eventTimestamp(),
  }),
  options,
);

/** The reason is mailed to the applicant. */
export const InstructorApplicationRejected = defineEvent(
  'InstructorApplicationRejected',
  1,
  z.object({
    applicationId: eventId(),
    applicantId: eventId(),
    decidedBy: eventId(),
    reason: z.string().min(10).max(1000),
    decidedAt: eventTimestamp(),
  }),
  options,
);

export const InstructorApplicationWithdrawn = defineEvent(
  'InstructorApplicationWithdrawn',
  1,
  z.object({
    applicationId: eventId(),
    applicantId: eventId(),
    withdrawnAt: eventTimestamp(),
  }),
  options,
);

/** Every v1 event on the `users.instructor_application` topic. */
export const USERS_INSTRUCTOR_APPLICATION_EVENTS = [
  InstructorApplicationSubmitted,
  InstructorApplicationApproved,
  InstructorApplicationRejected,
  InstructorApplicationWithdrawn,
] as const;

export type InstructorApplicationSubmittedPayload = EventPayload<
  typeof InstructorApplicationSubmitted
>;
export type InstructorApplicationApprovedPayload = EventPayload<
  typeof InstructorApplicationApproved
>;
export type InstructorApplicationRejectedPayload = EventPayload<
  typeof InstructorApplicationRejected
>;
export type InstructorApplicationWithdrawnPayload = EventPayload<
  typeof InstructorApplicationWithdrawn
>;
