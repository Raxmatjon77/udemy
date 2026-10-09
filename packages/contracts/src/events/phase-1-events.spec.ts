import { describe, expect, it } from 'vitest';
import {
  ACCESS_USER_ROLE_AGGREGATE,
  ACCESS_USER_ROLE_EVENTS,
  RoleGranted,
  RoleRevoked,
} from './access';
import type { EventDefinition } from './define-event';
import {
  DisplayNameChanged,
  EmailVerificationRequested,
  EmailVerified,
  IDENTITY_USER_AGGREGATE,
  IDENTITY_USER_EVENTS,
  PasswordChanged,
  PasswordResetRequested,
  SessionCompromiseDetected,
  SignupAttemptedForExistingEmail,
  UserBanned,
  UserRegistered,
  UserUnbanned,
} from './identity';
import {
  InstructorApplicationApproved,
  InstructorApplicationRejected,
  InstructorApplicationSubmitted,
  InstructorApplicationWithdrawn,
  USERS_INSTRUCTOR_APPLICATION_AGGREGATE,
  USERS_INSTRUCTOR_APPLICATION_EVENTS,
} from './users';

const userId = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c01';
const otherId = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c02';
const thirdId = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c03';
const at = '2026-10-10T12:00:00.000Z';
const email = 'jane@example.com';
const displayName = 'Jane Doe';
const reason = 'Repeated spam in course Q&A.';

/** One valid sample payload per event; the keys double as the full event list. */
const samples = new Map<EventDefinition, Record<string, unknown>>([
  [UserRegistered, { userId, email, displayName, registeredAt: at }],
  [EmailVerificationRequested, { userId, email, displayName, reason: 'SIGNUP', requestedAt: at }],
  [EmailVerified, { userId, email, verifiedAt: at }],
  [SignupAttemptedForExistingEmail, { userId, email, displayName, attemptedAt: at }],
  [PasswordResetRequested, { userId, email, displayName, requestedAt: at }],
  [PasswordChanged, { userId, via: 'RESET', changedAt: at }],
  [SessionCompromiseDetected, { userId, sessionId: otherId, clientApp: 'student', detectedAt: at }],
  [DisplayNameChanged, { userId, displayName, changedAt: at }],
  [UserBanned, { userId, banId: otherId, reason, bannedBy: thirdId, bannedAt: at }],
  [UserUnbanned, { userId, banId: otherId, liftedBy: thirdId, liftedAt: at }],
  [
    RoleGranted,
    {
      userId,
      role: 'INSTRUCTOR',
      grantedBy: thirdId,
      source: { type: 'instructor_application', id: otherId },
      grantedAt: at,
    },
  ],
  [
    RoleRevoked,
    { userId, role: 'ADMIN', revokedBy: thirdId, reason: 'No longer staff', revokedAt: at },
  ],
  [
    InstructorApplicationSubmitted,
    { applicationId: otherId, applicantId: userId, submittedAt: at },
  ],
  [
    InstructorApplicationApproved,
    { applicationId: otherId, applicantId: userId, decidedBy: thirdId, decidedAt: at },
  ],
  [
    InstructorApplicationRejected,
    { applicationId: otherId, applicantId: userId, decidedBy: thirdId, reason, decidedAt: at },
  ],
  [
    InstructorApplicationWithdrawn,
    { applicationId: otherId, applicantId: userId, withdrawnAt: at },
  ],
]);

const allEvents: readonly EventDefinition[] = [
  ...IDENTITY_USER_EVENTS,
  ...USERS_INSTRUCTOR_APPLICATION_EVENTS,
  ...ACCESS_USER_ROLE_EVENTS,
];

const cases = [...samples].map(([event, payload]) => ({ name: event.type, event, payload }));

describe('Phase 1 events', () => {
  it('has a sample for every event in the topic lists', () => {
    expect(new Set(allEvents)).toEqual(new Set(samples.keys()));
    expect(new Set(allEvents.map((e) => e.qualifiedType)).size).toBe(allEvents.length);
  });

  it.each(cases)('$name round-trips through JSON', ({ event, payload }) => {
    const parsed = event.parsePayload(JSON.parse(JSON.stringify(payload)));
    expect(parsed).toEqual(payload);
    expect(event.parsePayload(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(event.version).toBe(1);
    expect(event.qualifiedType).toBe(`${event.type}.v1`);
  });

  it.each(cases)('$name rejects a missing field and a non-ISO timestamp', ({ event, payload }) => {
    const missing = { ...payload };
    delete missing[Object.keys(payload)[0]!];
    expect(event.safeParsePayload(missing).success).toBe(false);

    const timestampKey = Object.keys(payload).find((key) => key.endsWith('At'))!;
    expect(event.safeParsePayload({ ...payload, [timestampKey]: '10/10/2026' }).success).toBe(
      false,
    );
  });

  it.each(cases)('$name strips unknown fields so secrets cannot leak', ({ event, payload }) => {
    const parsed = event.parsePayload({ ...payload, passwordHash: '$argon2id$x', token: 'raw' });
    expect(parsed).not.toHaveProperty('passwordHash');
    expect(parsed).not.toHaveProperty('token');
  });

  it('routes each event to its topic', () => {
    for (const e of IDENTITY_USER_EVENTS) expect(e.aggregateType).toBe(IDENTITY_USER_AGGREGATE);
    for (const e of USERS_INSTRUCTOR_APPLICATION_EVENTS) {
      expect(e.aggregateType).toBe(USERS_INSTRUCTOR_APPLICATION_AGGREGATE);
    }
    for (const e of ACCESS_USER_ROLE_EVENTS)
      expect(e.aggregateType).toBe(ACCESS_USER_ROLE_AGGREGATE);
    expect([
      IDENTITY_USER_AGGREGATE,
      USERS_INSTRUCTOR_APPLICATION_AGGREGATE,
      ACCESS_USER_ROLE_AGGREGATE,
    ]).toEqual(['identity.user', 'users.instructor_application', 'access.user_role']);
  });

  it('enforces the enums', () => {
    const base = samples.get(EmailVerificationRequested)!;
    expect(EmailVerificationRequested.safeParsePayload({ ...base, reason: 'RESEND' }).success).toBe(
      true,
    );
    expect(EmailVerificationRequested.safeParsePayload({ ...base, reason: 'OTHER' }).success).toBe(
      false,
    );
    const changed = samples.get(PasswordChanged)!;
    expect(PasswordChanged.safeParsePayload({ ...changed, via: 'CHANGE' }).success).toBe(true);
    expect(PasswordChanged.safeParsePayload({ ...changed, via: 'ADMIN' }).success).toBe(false);
  });

  it('RoleGranted mirrors the role_changes source rules', () => {
    const base = samples.get(RoleGranted)!;
    const cli = { ...base, role: 'ADMIN', grantedBy: null, source: { type: 'cli_bootstrap' } };
    expect(RoleGranted.parsePayload(cli)).toEqual(cli);
    expect(RoleGranted.safeParsePayload({ ...cli, grantedBy: thirdId }).success).toBe(false);
    expect(RoleGranted.safeParsePayload({ ...base, grantedBy: null }).success).toBe(false);
    expect(
      RoleGranted.safeParsePayload({ ...base, source: { type: 'instructor_application' } }).success,
    ).toBe(false);
    expect(RoleGranted.safeParsePayload({ ...base, role: 'STUDENT' }).success).toBe(false);
  });

  it('UserBanned / Rejected enforce the 10–1000 reason', () => {
    const ban = samples.get(UserBanned)!;
    expect(UserBanned.safeParsePayload({ ...ban, reason: 'too short' }).success).toBe(false);
    expect(UserBanned.safeParsePayload({ ...ban, reason: 'x'.repeat(1001) }).success).toBe(false);
  });
});
