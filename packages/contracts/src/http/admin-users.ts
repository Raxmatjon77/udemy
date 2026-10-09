import { z } from 'zod';
import { AssignableRoleSchema, RoleSchema } from '../auth/role';
import { AccountStatusSchema } from './account-status';
import { DecisionReasonSchema, IsoDateTimeSchema, multilineText, UuidSchema } from './fields';
import { emptyToUndefined, pageSchema, PaginationQuerySchema } from './pagination';

/* ----------------------------------------------------------------------------------------
 * GET /admin/users?q=&status=&role=&cursor=&limit= -> 200 page of AdminUserRow, newest first
 * -------------------------------------------------------------------------------------- */

export const AdminUsersQuerySchema = PaginationQuerySchema.extend({
  /**
   * Matches display name or email (case-insensitive substring). At least 3 characters,
   * because the trigram indexes cannot serve shorter patterns.
   */
  q: z.preprocess(emptyToUndefined, z.string().trim().min(3).max(254).optional()),
  status: z.preprocess(emptyToUndefined, AccountStatusSchema.optional()),
  /** STUDENT is implicit (everyone holds it), so only assignable roles can be filtered on. */
  role: z.preprocess(emptyToUndefined, AssignableRoleSchema.optional()),
});
export type AdminUsersQuery = z.output<typeof AdminUsersQuerySchema>;

export const AdminUserRowSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
  roles: z.array(RoleSchema),
  status: AccountStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;

export const AdminUserPageSchema = pageSchema(AdminUserRowSchema);
export type AdminUserPage = z.infer<typeof AdminUserPageSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /admin/users/:userId -> 200 AdminUserDetail
 * -------------------------------------------------------------------------------------- */

/** One ban, active (`liftedAt` null) or lifted. */
export const BanRecordSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  reason: z.string(),
  bannedBy: UuidSchema,
  bannedAt: IsoDateTimeSchema,
  liftedAt: IsoDateTimeSchema.nullable(),
  liftedBy: UuidSchema.nullable(),
  liftReason: z.string().nullable(),
});
export type BanRecord = z.infer<typeof BanRecordSchema>;

export const AdminUserSummarySchema = z.object({
  id: UuidSchema,
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
  status: AccountStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>;

export const AdminUserDetailSchema = z.object({
  user: AdminUserSummarySchema,
  roles: z.array(RoleSchema),
  /** Newest first. */
  bans: z.array(BanRecordSchema),
  activeSessionCount: z.number().int().min(0),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /admin/users/:userId/ban   -> 200 BanRecord
 * POST /admin/users/:userId/unban -> 200 BanRecord (the lifted ban)
 * -------------------------------------------------------------------------------------- */

export const BanUserRequestSchema = z.object({ reason: DecisionReasonSchema });
export type BanUserRequest = z.output<typeof BanUserRequestSchema>;

/** The lift reason is optional and only bounded by the DB rule (1–1000 chars). */
export const UnbanUserRequestSchema = z.object({ reason: multilineText(1, 1000).optional() });
export type UnbanUserRequest = z.output<typeof UnbanUserRequestSchema>;

export const BanUserResponseSchema = BanRecordSchema;
export type BanUserResponse = BanRecord;

/** §8 only says "200"; returning the lifted ban keeps the admin UI free of a refetch. */
export const UnbanUserResponseSchema = BanRecordSchema;
export type UnbanUserResponse = BanRecord;
