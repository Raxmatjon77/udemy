import { z } from 'zod';
import { AssignableRoleSchema } from '../auth/role';
import { defineEvent, type EventPayload } from './define-event';
import { eventId, eventTimestamp } from './payload-fields';

/** Aggregate type and Kafka topic of role assignment events; aggregateId = userId. */
export const ACCESS_USER_ROLE_AGGREGATE = 'access.user_role';
const options = { aggregateType: ACCESS_USER_ROLE_AGGREGATE } as const;

export const ROLE_GRANT_SOURCE_TYPES = [
  'instructor_application',
  'cli_bootstrap',
  'admin',
] as const;
export const RoleGrantSourceTypeSchema = z.enum(ROLE_GRANT_SOURCE_TYPES);
export type RoleGrantSourceType = z.infer<typeof RoleGrantSourceTypeSchema>;

/**
 * Why a role was granted. Mirrors the `access.role_changes` CHECKs: `id` (the application
 * id) is present iff the source is an instructor application.
 */
export const RoleGrantSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('instructor_application'), id: z.uuid() }),
  z.object({ type: z.literal('cli_bootstrap') }),
  z.object({ type: z.literal('admin') }),
]);
export type RoleGrantSource = z.infer<typeof RoleGrantSourceSchema>;

/** STUDENT is implicit (D5) and never granted, so `role` is INSTRUCTOR or ADMIN. */
export const RoleGranted = defineEvent(
  'RoleGranted',
  1,
  z
    .object({
      userId: eventId(),
      role: AssignableRoleSchema,
      /** `null` only for the CLI bootstrap of the first admin. */
      grantedBy: eventId().nullable(),
      source: RoleGrantSourceSchema,
      grantedAt: eventTimestamp(),
    })
    .refine((p) => (p.grantedBy === null) === (p.source.type === 'cli_bootstrap'), {
      message: 'grantedBy must be null exactly when source.type is cli_bootstrap',
      path: ['grantedBy'],
    }),
  options,
);

export const RoleRevoked = defineEvent(
  'RoleRevoked',
  1,
  z.object({
    userId: eventId(),
    role: AssignableRoleSchema,
    revokedBy: eventId(),
    reason: z.string().min(1).max(1000),
    revokedAt: eventTimestamp(),
  }),
  options,
);

/** Every v1 event on the `access.user_role` topic. */
export const ACCESS_USER_ROLE_EVENTS = [RoleGranted, RoleRevoked] as const;

export type RoleGrantedPayload = EventPayload<typeof RoleGranted>;
export type RoleRevokedPayload = EventPayload<typeof RoleRevoked>;
