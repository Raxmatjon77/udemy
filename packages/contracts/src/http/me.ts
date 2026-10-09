import { z } from 'zod';
import { ClientAppSchema } from '../auth/client-app';
import { PermissionSchema } from '../auth/permissions';
import { RoleSchema } from '../auth/role';
import { BioSchema, DisplayNameSchema, HeadlineSchema, UuidSchema } from './fields';

/* ----------------------------------------------------------------------------------------
 * GET /me/profile -> 200 Profile
 * PATCH /me/profile -> 200 Profile
 * -------------------------------------------------------------------------------------- */

/** The caller's own profile. Before the first PATCH the optional fields are null (defaults). */
export const ProfileSchema = z.object({
  userId: UuidSchema,
  displayName: z.string(),
  headline: z.string().nullable(),
  bio: z.string().nullable(),
  /** Always null until media uploads exist (Phase 2). */
  avatarUrl: z.string().nullable(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Partial update; at least one field is required. `null` clears `headline`/`bio`;
 * `displayName` cannot be cleared.
 */
export const UpdateProfileRequestSchema = z
  .object({
    displayName: DisplayNameSchema.optional(),
    headline: HeadlineSchema.nullable().optional(),
    bio: BioSchema.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one of displayName, headline or bio is required',
  })
  .meta({ minProperties: 1 });
export type UpdateProfileRequest = z.output<typeof UpdateProfileRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /me -> 200 Me
 * -------------------------------------------------------------------------------------- */

export const MeProfileSchema = ProfileSchema.pick({ headline: true, bio: true, avatarUrl: true });
export type MeProfile = z.infer<typeof MeProfileSchema>;

export const MeResponseSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
  /** All roles held, always including STUDENT. */
  roles: z.array(RoleSchema),
  /** Effective permissions in the calling app (baseline + roles allowed in that app). */
  permissions: z.array(PermissionSchema),
  app: ClientAppSchema,
  profile: MeProfileSchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /users/:userId/profile -> 200 PublicProfile
 * -------------------------------------------------------------------------------------- */

export const UserIdParamsSchema = z.object({ userId: UuidSchema });
export type UserIdParams = z.output<typeof UserIdParamsSchema>;

/** What anyone may see about a user. Banned users are 404 (`user_not_found`). */
export const PublicProfileSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  headline: z.string().nullable(),
  bio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  isInstructor: z.boolean(),
});
export type PublicProfile = z.infer<typeof PublicProfileSchema>;
