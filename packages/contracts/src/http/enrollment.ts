import { z } from 'zod';
import { PersonRefSchema } from './catalog';
import { AdminMoneyReasonSchema } from './commerce-common';
import { IsoDateTimeSchema, UuidSchema } from './fields';
import { pageSchema, paginationQuerySchema } from './pagination';

/**
 * Enrollment (Phase 4 design §4 Enrollment, §5, §8). Enums mirror the `enrollment.*` CHECKs.
 */

export const ENROLLMENT_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export const EnrollmentStatusSchema = z.enum(ENROLLMENT_STATUSES);
export type EnrollmentStatus = z.infer<typeof EnrollmentStatusSchema>;

export const ENROLLMENT_SOURCES = ['ORDER', 'FREE', 'ADMIN'] as const;
export const EnrollmentSourceSchema = z.enum(ENROLLMENT_SOURCES);
export type EnrollmentSource = z.infer<typeof EnrollmentSourceSchema>;

export const ENROLLMENT_REVOKE_REASONS = ['REFUND', 'ADMIN', 'CHARGEBACK'] as const;
export const EnrollmentRevokeReasonSchema = z.enum(ENROLLMENT_REVOKE_REASONS);
export type EnrollmentRevokeReason = z.infer<typeof EnrollmentRevokeReasonSchema>;

export const ENROLLMENT_TRANSITION_ACTIONS = ['GRANT', 'REVOKE', 'REGRANT'] as const;
export const EnrollmentTransitionActionSchema = z.enum(ENROLLMENT_TRANSITION_ACTIONS);
export type EnrollmentTransitionAction = z.infer<typeof EnrollmentTransitionActionSchema>;

export const EnrollmentSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  courseId: UuidSchema,
  status: EnrollmentStatusSchema,
  source: EnrollmentSourceSchema,
  /** Set exactly when `source` is ORDER. */
  orderLineId: UuidSchema.nullable(),
  grantedAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
  revokeReason: EnrollmentRevokeReasonSchema.nullable(),
});
export type Enrollment = z.infer<typeof EnrollmentSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /me/free-enrollments -> 201 Enrollment (new or re-granted) / 200 (already active)
 *   (P `enrollment:create`; 404 course_not_found, 409 course_not_free |
 *    cannot_purchase_own_course | course_not_for_sale, 429; 30 per hour).
 * No email verification needed (D17) and no order (D14).
 * -------------------------------------------------------------------------------------- */

export const FreeEnrollmentRequestSchema = z.object({ courseId: UuidSchema });
export type FreeEnrollmentRequest = z.output<typeof FreeEnrollmentRequestSchema>;

export const FreeEnrollmentResponseSchema = EnrollmentSchema;
export type FreeEnrollmentResponse = Enrollment;

/* ----------------------------------------------------------------------------------------
 * GET /me/enrollments?cursor=&limit= -> 200 LearningCardPage (P `enrollment:read:own`)
 * "My learning": ACTIVE enrollments, keyset (grantedAt DESC, id DESC), limit ≤ 24.
 * -------------------------------------------------------------------------------------- */

export const MY_LEARNING_PAGE_LIMIT_MAX = 24;
export const MY_LEARNING_PAGE_LIMIT_DEFAULT = 24;

export const MyLearningQuerySchema = paginationQuerySchema(
  MY_LEARNING_PAGE_LIMIT_MAX,
  MY_LEARNING_PAGE_LIMIT_DEFAULT,
);
export type MyLearningQuery = z.output<typeof MyLearningQuerySchema>;

export const LearningCardSchema = z.object({
  enrollmentId: UuidSchema,
  courseId: UuidSchema,
  slug: z.string(),
  /** Live title. */
  title: z.string(),
  instructor: PersonRefSchema.nullable(),
  hasThumbnail: z.boolean(),
  /** The course was archived; enrolled students keep access (D13): show a badge. */
  archived: z.boolean(),
  source: EnrollmentSourceSchema,
  grantedAt: IsoDateTimeSchema,
  /**
   * Percent complete (Phase 5 design D5, D21): ⌊completed ∩ live lecture ids / live lecture
   * count × 100⌋ from `COURSE_PROGRESS` (`LearningProgressReader`); 0 when nothing is completed,
   * 100 means truly complete ("Start learning" at 0, "N% complete" above it). Null when no
   * progress reader is bound (`NoCourseProgress`) or the course has no live revision.
   * A later revision that adds lectures lowers it, but the course completion is permanent.
   */
  progress: z.number().int().min(0).max(100).nullable(),
});
export type LearningCard = z.infer<typeof LearningCardSchema>;

export const LearningCardPageSchema = pageSchema(LearningCardSchema);
export type LearningCardPage = z.infer<typeof LearningCardPageSchema>;

/* ----------------------------------------------------------------------------------------
 * Admin (admin BFF):
 *
 *   GET  /admin/users/:userId/enrollments   -> 200 AdminUserEnrollments (P enrollment:read:any; 404)
 *   POST /admin/enrollments                 -> 201 AdminEnrollment      (P enrollment:grant:any;
 *        404, 409 already_enrolled)
 *   POST /admin/enrollments/:enrollmentId/revoke -> 200 AdminEnrollment (P enrollment:grant:any;
 *        404 enrollment_not_found, 409 invalid_state_transition)
 *
 * `/admin/users/:userId/...` takes `UserIdParamsSchema`.
 * -------------------------------------------------------------------------------------- */

export const EnrollmentTransitionSchema = z.object({
  id: UuidSchema,
  action: EnrollmentTransitionActionSchema,
  source: EnrollmentSourceSchema.nullable(),
  orderLineId: UuidSchema.nullable(),
  refundId: UuidSchema.nullable(),
  reason: z.string().nullable(),
  actorId: UuidSchema.nullable(),
  occurredAt: IsoDateTimeSchema,
});
export type EnrollmentTransition = z.infer<typeof EnrollmentTransitionSchema>;

export const AdminEnrollmentSchema = EnrollmentSchema.extend({
  course: z.object({
    id: UuidSchema,
    slug: z.string().nullable(),
    /** Null when the course no longer exists. */
    title: z.string().nullable(),
    archived: z.boolean(),
  }),
  /** Oldest first. */
  transitions: z.array(EnrollmentTransitionSchema),
});
export type AdminEnrollment = z.infer<typeof AdminEnrollmentSchema>;

export const AdminUserEnrollmentsSchema = z.object({ items: z.array(AdminEnrollmentSchema) });
export type AdminUserEnrollments = z.infer<typeof AdminUserEnrollmentsSchema>;

export const AdminGrantEnrollmentRequestSchema = z.object({
  userId: UuidSchema,
  courseId: UuidSchema,
  reason: AdminMoneyReasonSchema,
});
export type AdminGrantEnrollmentRequest = z.output<typeof AdminGrantEnrollmentRequestSchema>;

export const EnrollmentIdParamsSchema = z.object({ enrollmentId: UuidSchema });
export type EnrollmentIdParams = z.output<typeof EnrollmentIdParamsSchema>;

export const AdminRevokeEnrollmentRequestSchema = z.object({ reason: AdminMoneyReasonSchema });
export type AdminRevokeEnrollmentRequest = z.output<typeof AdminRevokeEnrollmentRequestSchema>;

export const AdminEnrollmentResponseSchema = AdminEnrollmentSchema;
export type AdminEnrollmentResponse = AdminEnrollment;
