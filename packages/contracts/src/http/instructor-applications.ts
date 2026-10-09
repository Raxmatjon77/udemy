import { z } from 'zod';
import { AccountStatusSchema } from './account-status';
import {
  HttpsUrlSchema,
  IsoDateTimeSchema,
  multilineText,
  UuidSchema,
  DecisionReasonSchema,
} from './fields';
import { emptyToUndefined, pageSchema, PaginationQuerySchema } from './pagination';

export const INSTRUCTOR_APPLICATION_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export const InstructorApplicationStatusSchema = z.enum(INSTRUCTOR_APPLICATION_STATUSES);
export type InstructorApplicationStatus = z.infer<typeof InstructorApplicationStatusSchema>;

export const EXPERIENCE_LEVELS = ['NONE', 'INFORMAL', 'PROFESSIONAL', 'ONLINE'] as const;
export const ExperienceLevelSchema = z.enum(EXPERIENCE_LEVELS);
export type ExperienceLevel = z.infer<typeof ExperienceLevelSchema>;

export const InstructorApplicationIdParamsSchema = z.object({ id: UuidSchema });
export type InstructorApplicationIdParams = z.output<typeof InstructorApplicationIdParamsSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /me/instructor-applications -> 201 InstructorApplication
 * -------------------------------------------------------------------------------------- */

export const SubmitInstructorApplicationRequestSchema = z.object({
  motivation: multilineText(100, 3000),
  expertise: multilineText(3, 200),
  experienceLevel: ExperienceLevelSchema,
  portfolioUrl: HttpsUrlSchema.optional(),
});
export type SubmitInstructorApplicationRequest = z.output<
  typeof SubmitInstructorApplicationRequestSchema
>;

/* ----------------------------------------------------------------------------------------
 * Application views
 * -------------------------------------------------------------------------------------- */

/** One state change; `fromStatus` is null for the submission. */
export const InstructorApplicationTransitionSchema = z.object({
  fromStatus: InstructorApplicationStatusSchema.nullable(),
  toStatus: InstructorApplicationStatusSchema,
  actorId: UuidSchema,
  /** Rejection reason, or the optional approval note. */
  reason: z.string().nullable(),
  occurredAt: IsoDateTimeSchema,
});
export type InstructorApplicationTransition = z.infer<typeof InstructorApplicationTransitionSchema>;

export const InstructorApplicationSchema = z.object({
  id: UuidSchema,
  applicantId: UuidSchema,
  status: InstructorApplicationStatusSchema,
  motivation: z.string(),
  expertise: z.string(),
  experienceLevel: ExperienceLevelSchema,
  portfolioUrl: z.string().nullable(),
  submittedAt: IsoDateTimeSchema,
  /** Optimistic-lock version; send it back as `expectedVersion` when deciding. */
  version: z.number().int().min(1),
  /** Oldest first. */
  transitions: z.array(InstructorApplicationTransitionSchema),
});
export type InstructorApplication = z.infer<typeof InstructorApplicationSchema>;

export const ApplicantSummarySchema = z.object({
  id: UuidSchema,
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
  /** Admins see the ban flag in the queue (a ban does not withdraw a pending application). */
  status: AccountStatusSchema,
});
export type ApplicantSummary = z.infer<typeof ApplicantSummarySchema>;

/** `GET /instructor-applications/:id` and the admin queue items. */
export const InstructorApplicationDetailSchema = InstructorApplicationSchema.extend({
  applicant: ApplicantSummarySchema,
});
export type InstructorApplicationDetail = z.infer<typeof InstructorApplicationDetailSchema>;

/** `GET /me/instructor-applications` -> 200 `{ items }`, newest first. */
export const MyInstructorApplicationsResponseSchema = z.object({
  items: z.array(InstructorApplicationSchema),
});
export type MyInstructorApplicationsResponse = z.infer<
  typeof MyInstructorApplicationsResponseSchema
>;

/* ----------------------------------------------------------------------------------------
 * GET /admin/instructor-applications?status=PENDING&cursor=&limit= -> 200 page, oldest first
 * -------------------------------------------------------------------------------------- */

export const AdminInstructorApplicationsQuerySchema = PaginationQuerySchema.extend({
  status: z.preprocess(emptyToUndefined, InstructorApplicationStatusSchema.default('PENDING')),
});
export type AdminInstructorApplicationsQuery = z.output<
  typeof AdminInstructorApplicationsQuerySchema
>;

export const InstructorApplicationPageSchema = pageSchema(InstructorApplicationDetailSchema);
export type InstructorApplicationPage = z.infer<typeof InstructorApplicationPageSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /admin/instructor-applications/:id/approve -> 200 InstructorApplication
 * POST /admin/instructor-applications/:id/reject  -> 200 InstructorApplication
 * -------------------------------------------------------------------------------------- */

/** When sent and stale, the decision fails with 409 `version_conflict`. */
const ExpectedVersionSchema = z.number().int().min(1);

export const ApproveInstructorApplicationRequestSchema = z.object({
  /** Stored as the transition reason (1–1000 chars). */
  note: multilineText(1, 1000).optional(),
  expectedVersion: ExpectedVersionSchema.optional(),
});
export type ApproveInstructorApplicationRequest = z.output<
  typeof ApproveInstructorApplicationRequestSchema
>;

export const RejectInstructorApplicationRequestSchema = z.object({
  reason: DecisionReasonSchema,
  expectedVersion: ExpectedVersionSchema.optional(),
});
export type RejectInstructorApplicationRequest = z.output<
  typeof RejectInstructorApplicationRequestSchema
>;
