import { z } from 'zod';
import { PersonRefSchema } from './catalog';
import { IsoDateTimeSchema, multilineText, UuidSchema } from './fields';
import { CompactPaginationQuerySchema, emptyToUndefined, pageSchema } from './pagination';

/**
 * Reports and moderation (Phase 5 learning experience design D13, §4 Report, §5, §8).
 *
 *   POST /engagement/{reviews|review-replies|questions|answers}/:subjectId/reports
 *        {reason, comment?} -> 201 Report (new) / 200 Report (repeat)
 *        (P content:report; 404 (not visible to the reporter), 422 cannot_report_own_content, 429)
 *   GET  /admin/moderation/reports?type=&status=&cursor=&limit= -> 200 ModerationQueuePage
 *        (P content:moderate:any; 400)
 *   POST /admin/moderation/{reviews|review-replies|questions|answers}/:subjectId/hide    {reason}
 *   POST /admin/moderation/{reviews|review-replies|questions|answers}/:subjectId/restore {reason}
 *   POST /admin/moderation/{reviews|review-replies|questions|answers}/:subjectId/dismiss-reports {reason}
 *        -> 200 ModerationSubject (404, 409 invalid_state_transition)
 *
 * A review reply is addressed by its review id (`review_replies` is keyed by `review_id`).
 * `ENGAGEMENT_AUTO_HIDE_REPORTS` (default 3) distinct OPEN reports hide the subject
 * automatically (a `moderation_actions` row with no actor). A restore dismisses the open reports.
 */

/** `moderation_actions.subject_type`; announcements are moderated by deletion only. */
export const MODERATION_SUBJECT_TYPES = [
  'REVIEW',
  'REVIEW_REPLY',
  'QUESTION',
  'ANSWER',
  'ANNOUNCEMENT',
] as const;
export const ModerationSubjectTypeSchema = z.enum(MODERATION_SUBJECT_TYPES);
export type ModerationSubjectType = z.infer<typeof ModerationSubjectTypeSchema>;

/** Subjects that can be reported (one report table each). */
export const REPORT_SUBJECT_TYPES = [
  'REVIEW',
  'REVIEW_REPLY',
  'QUESTION',
  'ANSWER',
] as const satisfies readonly ModerationSubjectType[];
export const ReportSubjectTypeSchema = z.enum(REPORT_SUBJECT_TYPES);
export type ReportSubjectType = z.infer<typeof ReportSubjectTypeSchema>;

/** The `{type}` path segment of the report and moderation routes. */
export const REPORT_SUBJECT_PATHS: Readonly<Record<ReportSubjectType, string>> = Object.freeze({
  REVIEW: 'reviews',
  REVIEW_REPLY: 'review-replies',
  QUESTION: 'questions',
  ANSWER: 'answers',
});

export function reportSubjectTypeOfPath(segment: string): ReportSubjectType | null {
  for (const type of REPORT_SUBJECT_TYPES) {
    if (REPORT_SUBJECT_PATHS[type] === segment) return type;
  }
  return null;
}

export const REPORT_REASONS = [
  'SPAM',
  'ABUSE',
  'HARASSMENT',
  'OFF_TOPIC',
  'INAPPROPRIATE',
  'OTHER',
] as const;
export const ReportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = Object.freeze({
  SPAM: 'Spam or advertising',
  ABUSE: 'Abusive or hateful',
  HARASSMENT: 'Harassment',
  OFF_TOPIC: 'Off topic',
  INAPPROPRIATE: 'Inappropriate content',
  OTHER: 'Something else',
});

export const REPORT_STATUSES = ['OPEN', 'ACTIONED', 'DISMISSED'] as const;
export const ReportStatusSchema = z.enum(REPORT_STATUSES);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const MODERATION_ACTIONS = ['HIDE', 'RESTORE', 'DISMISS_REPORTS'] as const;
export const ModerationActionTypeSchema = z.enum(MODERATION_ACTIONS);
export type ModerationActionType = z.infer<typeof ModerationActionTypeSchema>;

export const MODERATION_STATUSES = ['VISIBLE', 'HIDDEN'] as const;
export const ModerationStatusSchema = z.enum(MODERATION_STATUSES);
export type ModerationStatus = z.infer<typeof ModerationStatusSchema>;

/** `ENGAGEMENT_AUTO_HIDE_REPORTS` default. */
export const AUTO_HIDE_REPORT_THRESHOLD = 3;

export const ReportSubjectParamsSchema = z.object({ subjectId: UuidSchema });
export type ReportSubjectParams = z.output<typeof ReportSubjectParamsSchema>;

/** `*_reports.comment` ≤ 500. */
export const ReportCommentSchema = multilineText(1, 500);

export const ReportContentRequestSchema = z.object({
  reason: ReportReasonSchema,
  comment: ReportCommentSchema.optional(),
});
export type ReportContentRequest = z.output<typeof ReportContentRequestSchema>;

/** The caller's report (a repeat returns the existing one). */
export const ReportSchema = z.object({
  id: UuidSchema,
  subjectType: ReportSubjectTypeSchema,
  subjectId: UuidSchema,
  reason: ReportReasonSchema,
  comment: z.string().nullable(),
  status: ReportStatusSchema,
  createdAt: IsoDateTimeSchema,
});
export type Report = z.infer<typeof ReportSchema>;

/* ----------------------------------------------------------------------------------------
 * Admin moderation queue: one item per reported subject with at least one report in `status`
 * (default OPEN), newest report first, keyset (lastReportedAt DESC, subjectId DESC).
 * -------------------------------------------------------------------------------------- */

export const ModerationQueueQuerySchema = CompactPaginationQuerySchema.extend({
  type: z.preprocess(emptyToUndefined, ReportSubjectTypeSchema.optional()),
  status: z.preprocess(emptyToUndefined, ReportStatusSchema.default('OPEN')),
});
export type ModerationQueueQuery = z.output<typeof ModerationQueueQuerySchema>;

export const ModerationActionSchema = z.object({
  id: UuidSchema,
  subjectType: ModerationSubjectTypeSchema,
  subjectId: UuidSchema,
  action: ModerationActionTypeSchema,
  /** Null = AUTO (the report threshold). Admin views show actors even when banned. */
  actor: PersonRefSchema.nullable(),
  reason: z.string().nullable(),
  occurredAt: IsoDateTimeSchema,
});
export type ModerationAction = z.infer<typeof ModerationActionSchema>;

export const ModerationReportSchema = ReportSchema.extend({
  reporter: PersonRefSchema.nullable(),
  resolvedAt: IsoDateTimeSchema.nullable(),
});
export type ModerationReport = z.infer<typeof ModerationReportSchema>;

/**
 * The reported content as the admin previews it: `title` for questions, `bodyMd` is markdown
 * for questions/answers and plain text for reviews/replies (`bodyIsMarkdown`).
 */
export const ModerationSubjectPreviewSchema = z.object({
  title: z.string().nullable(),
  body: z.string().nullable(),
  bodyIsMarkdown: z.boolean(),
  /** Reviews only. */
  rating: z.number().int().min(1).max(5).nullable(),
  author: PersonRefSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  deleted: z.boolean(),
});
export type ModerationSubjectPreview = z.infer<typeof ModerationSubjectPreviewSchema>;

/** The state after an admin action, and the base of a queue item. */
export const ModerationSubjectSchema = z.object({
  subjectType: ReportSubjectTypeSchema,
  subjectId: UuidSchema,
  courseId: UuidSchema,
  courseTitle: z.string().nullable(),
  moderationStatus: ModerationStatusSchema,
  openReportCount: z.number().int().min(0),
  /** Oldest first. */
  actions: z.array(ModerationActionSchema),
});
export type ModerationSubject = z.infer<typeof ModerationSubjectSchema>;

export const ModerationQueueItemSchema = ModerationSubjectSchema.extend({
  preview: ModerationSubjectPreviewSchema,
  /** Newest first, at most 20. */
  reports: z.array(ModerationReportSchema).max(20),
  lastReportedAt: IsoDateTimeSchema,
});
export type ModerationQueueItem = z.infer<typeof ModerationQueueItemSchema>;

export const ModerationQueuePageSchema = pageSchema(ModerationQueueItemSchema);
export type ModerationQueuePage = z.infer<typeof ModerationQueuePageSchema>;

/**
 * Every admin action carries a reason (10–2000): the `moderation_actions` CHECK requires one
 * whenever there is an actor, so dismiss-reports needs it too.
 */
export const ModerationReasonRequestSchema = z.object({ reason: multilineText(10, 2000) });
export type ModerationReasonRequest = z.output<typeof ModerationReasonRequestSchema>;
