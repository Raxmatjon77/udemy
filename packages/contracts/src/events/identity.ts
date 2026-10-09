import { z } from 'zod';
import { ClientAppSchema } from '../auth/client-app';
import { defineEvent, type EventPayload } from './define-event';
import { eventDisplayName, eventEmail, eventId, eventTimestamp } from './payload-fields';

/** Aggregate type and Kafka topic of every identity account event; aggregateId = userId. */
export const IDENTITY_USER_AGGREGATE = 'identity.user';
const options = { aggregateType: IDENTITY_USER_AGGREGATE } as const;

export const EmailVerificationReasonSchema = z.enum(['SIGNUP', 'RESEND']);
export type EmailVerificationReason = z.infer<typeof EmailVerificationReasonSchema>;

export const PasswordChangeViaSchema = z.enum(['RESET', 'CHANGE']);
export type PasswordChangeVia = z.infer<typeof PasswordChangeViaSchema>;

export const UserRegistered = defineEvent(
  'UserRegistered',
  1,
  z.object({
    userId: eventId(),
    email: eventEmail(),
    displayName: eventDisplayName(),
    registeredAt: eventTimestamp(),
  }),
  options,
);

/** Consumed by the worker: issues the verification token and sends the mail (SIGNUP doubles as welcome). */
export const EmailVerificationRequested = defineEvent(
  'EmailVerificationRequested',
  1,
  z.object({
    userId: eventId(),
    email: eventEmail(),
    displayName: eventDisplayName(),
    reason: EmailVerificationReasonSchema,
    requestedAt: eventTimestamp(),
  }),
  options,
);

export const EmailVerified = defineEvent(
  'EmailVerified',
  1,
  z.object({
    userId: eventId(),
    email: eventEmail(),
    verifiedAt: eventTimestamp(),
  }),
  options,
);

/** Signup with an email that already has an account: the worker mails "reset your password?". */
export const SignupAttemptedForExistingEmail = defineEvent(
  'SignupAttemptedForExistingEmail',
  1,
  z.object({
    userId: eventId(),
    email: eventEmail(),
    displayName: eventDisplayName(),
    attemptedAt: eventTimestamp(),
  }),
  options,
);

/** Consumed by the worker: issues the reset token and sends the mail. */
export const PasswordResetRequested = defineEvent(
  'PasswordResetRequested',
  1,
  z.object({
    userId: eventId(),
    email: eventEmail(),
    displayName: eventDisplayName(),
    requestedAt: eventTimestamp(),
  }),
  options,
);

export const PasswordChanged = defineEvent(
  'PasswordChanged',
  1,
  z.object({
    userId: eventId(),
    via: PasswordChangeViaSchema,
    changedAt: eventTimestamp(),
  }),
  options,
);

/** Refresh-token reuse detected; the session (family) has been revoked. */
export const SessionCompromiseDetected = defineEvent(
  'SessionCompromiseDetected',
  1,
  z.object({
    userId: eventId(),
    sessionId: eventId(),
    clientApp: ClientAppSchema,
    detectedAt: eventTimestamp(),
  }),
  options,
);

export const DisplayNameChanged = defineEvent(
  'DisplayNameChanged',
  1,
  z.object({
    userId: eventId(),
    displayName: eventDisplayName(),
    changedAt: eventTimestamp(),
  }),
  options,
);

export const UserBanned = defineEvent(
  'UserBanned',
  1,
  z.object({
    userId: eventId(),
    banId: eventId(),
    reason: z.string().min(10).max(1000),
    bannedBy: eventId(),
    bannedAt: eventTimestamp(),
  }),
  options,
);

export const UserUnbanned = defineEvent(
  'UserUnbanned',
  1,
  z.object({
    userId: eventId(),
    banId: eventId(),
    liftedBy: eventId(),
    liftedAt: eventTimestamp(),
  }),
  options,
);

/** Every v1 event on the `identity.user` topic (e.g. for registering worker handlers). */
export const IDENTITY_USER_EVENTS = [
  UserRegistered,
  EmailVerificationRequested,
  EmailVerified,
  SignupAttemptedForExistingEmail,
  PasswordResetRequested,
  PasswordChanged,
  SessionCompromiseDetected,
  DisplayNameChanged,
  UserBanned,
  UserUnbanned,
] as const;

export type UserRegisteredPayload = EventPayload<typeof UserRegistered>;
export type EmailVerificationRequestedPayload = EventPayload<typeof EmailVerificationRequested>;
export type EmailVerifiedPayload = EventPayload<typeof EmailVerified>;
export type SignupAttemptedForExistingEmailPayload = EventPayload<
  typeof SignupAttemptedForExistingEmail
>;
export type PasswordResetRequestedPayload = EventPayload<typeof PasswordResetRequested>;
export type PasswordChangedPayload = EventPayload<typeof PasswordChanged>;
export type SessionCompromiseDetectedPayload = EventPayload<typeof SessionCompromiseDetected>;
export type DisplayNameChangedPayload = EventPayload<typeof DisplayNameChanged>;
export type UserBannedPayload = EventPayload<typeof UserBanned>;
export type UserUnbannedPayload = EventPayload<typeof UserUnbanned>;
