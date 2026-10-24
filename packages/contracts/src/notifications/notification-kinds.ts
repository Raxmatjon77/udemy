import { z } from 'zod';
import type { ClientApp } from '../auth/client-app';
import { MediaPurposeSchema } from '../http/media';

/**
 * Notification kinds, categories and payloads (Phase 5 learning experience design D14, §6
 * notifications). Shared by the worker (writes rows), the api (serves the inbox) and the web
 * apps (render them).
 *
 * A notification row carries a **typed snapshot payload** (≤ 4 KB): the message as it was told,
 * rendered as plain text. When moderation hides the subject, the worker **redacts** the payload
 * (`redacted: true`, user-authored text set to null) for every row about that subject.
 * The enum values mirror the `notifications.notifications` CHECK constraints.
 */

/** `notifications.app`: the app whose bell shows the row (uppercase, like the roles). */
export const NOTIFICATION_APPS = ['STUDENT', 'INSTRUCTOR', 'ADMIN'] as const;
export const NotificationAppSchema = z.enum(NOTIFICATION_APPS);
export type NotificationApp = z.infer<typeof NotificationAppSchema>;

/** The principal's `app` claim → its notification audience. */
export const NOTIFICATION_APP_OF_CLIENT: Readonly<Record<ClientApp, NotificationApp>> =
  Object.freeze({ student: 'STUDENT', instructor: 'INSTRUCTOR', admin: 'ADMIN' });

export const NOTIFICATION_CATEGORIES = [
  'QA',
  'REVIEWS',
  'ANNOUNCEMENTS',
  'LEARNING',
  'COURSE_BUILDING',
  'MODERATION',
] as const;
export const NotificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL'] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NOTIFICATION_KINDS = [
  'QA_NEW_QUESTION',
  'QA_NEW_ANSWER',
  'QA_RESOLVED',
  'REVIEW_NEW',
  'REVIEW_REPLY',
  'ANNOUNCEMENT',
  'CERTIFICATE_ISSUED',
  'MEDIA_READY',
  'MEDIA_FAILED',
  'CONTENT_HIDDEN',
  'MODERATION_QUEUE',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/** `notifications.subject_type`: what a row is about (moderation redacts by it). */
export const NOTIFICATION_SUBJECT_TYPES = [
  'QUESTION',
  'ANSWER',
  'REVIEW',
  'REVIEW_REPLY',
  'ANNOUNCEMENT',
  'CERTIFICATE',
  'MEDIA_ASSET',
] as const;
export const NotificationSubjectTypeSchema = z.enum(NOTIFICATION_SUBJECT_TYPES);
export type NotificationSubjectType = z.infer<typeof NotificationSubjectTypeSchema>;

export interface NotificationCategoryMeta {
  readonly label: string;
  /** Apps whose preference page shows the category. */
  readonly apps: readonly NotificationApp[];
  /** Code defaults per channel; a stored preference overrides them. */
  readonly defaults: Readonly<Record<NotificationChannel, boolean>>;
  /** Channels the user cannot turn off (422 `preference_locked`). */
  readonly locked: readonly NotificationChannel[];
}

/**
 * Category metadata. MODERATION is transactional (a notice that your content was hidden, the
 * admin queue): both channels are locked on. Everything else can be turned off.
 */
export const NOTIFICATION_CATEGORY_META: Readonly<
  Record<NotificationCategory, NotificationCategoryMeta>
> = Object.freeze({
  QA: {
    label: 'Questions & answers',
    apps: ['STUDENT', 'INSTRUCTOR'],
    defaults: { IN_APP: true, EMAIL: true },
    locked: [],
  },
  REVIEWS: {
    label: 'Reviews',
    apps: ['STUDENT', 'INSTRUCTOR'],
    defaults: { IN_APP: true, EMAIL: true },
    locked: [],
  },
  ANNOUNCEMENTS: {
    label: 'Course announcements',
    apps: ['STUDENT'],
    defaults: { IN_APP: true, EMAIL: true },
    locked: [],
  },
  LEARNING: {
    label: 'Learning (certificates)',
    apps: ['STUDENT'],
    defaults: { IN_APP: true, EMAIL: true },
    locked: [],
  },
  COURSE_BUILDING: {
    label: 'Course building (media processing)',
    apps: ['INSTRUCTOR'],
    defaults: { IN_APP: true, EMAIL: false },
    locked: [],
  },
  MODERATION: {
    label: 'Moderation',
    apps: ['STUDENT', 'INSTRUCTOR', 'ADMIN'],
    defaults: { IN_APP: true, EMAIL: true },
    locked: ['IN_APP', 'EMAIL'],
  },
});

export function isPreferenceLocked(
  category: NotificationCategory,
  channel: NotificationChannel,
): boolean {
  return NOTIFICATION_CATEGORY_META[category].locked.includes(channel);
}

export interface NotificationKindMeta {
  readonly category: NotificationCategory;
  /** Apps a row of this kind can be addressed to. */
  readonly apps: readonly NotificationApp[];
  readonly subjectType: NotificationSubjectType | null;
  /** Short English label for lists and the bell. */
  readonly label: string;
  /** Moderation can redact the payload (it quotes user-authored text). */
  readonly redactable: boolean;
}

/** Render and routing metadata per kind. */
export const NOTIFICATION_KIND_META: Readonly<Record<NotificationKind, NotificationKindMeta>> =
  Object.freeze({
    QA_NEW_QUESTION: {
      category: 'QA',
      apps: ['INSTRUCTOR'],
      subjectType: 'QUESTION',
      label: 'New question',
      redactable: true,
    },
    QA_NEW_ANSWER: {
      category: 'QA',
      apps: ['STUDENT', 'INSTRUCTOR'],
      subjectType: 'ANSWER',
      label: 'New answer',
      redactable: true,
    },
    QA_RESOLVED: {
      category: 'QA',
      apps: ['STUDENT', 'INSTRUCTOR'],
      subjectType: 'QUESTION',
      label: 'Answer accepted',
      redactable: true,
    },
    REVIEW_NEW: {
      category: 'REVIEWS',
      apps: ['INSTRUCTOR'],
      subjectType: 'REVIEW',
      label: 'New review',
      redactable: true,
    },
    REVIEW_REPLY: {
      category: 'REVIEWS',
      apps: ['STUDENT'],
      subjectType: 'REVIEW_REPLY',
      label: 'Instructor replied',
      redactable: true,
    },
    ANNOUNCEMENT: {
      category: 'ANNOUNCEMENTS',
      apps: ['STUDENT'],
      subjectType: 'ANNOUNCEMENT',
      label: 'Announcement',
      redactable: true,
    },
    CERTIFICATE_ISSUED: {
      category: 'LEARNING',
      apps: ['STUDENT'],
      subjectType: 'CERTIFICATE',
      label: 'Certificate ready',
      redactable: false,
    },
    MEDIA_READY: {
      category: 'COURSE_BUILDING',
      apps: ['INSTRUCTOR'],
      subjectType: 'MEDIA_ASSET',
      label: 'Media ready',
      redactable: false,
    },
    MEDIA_FAILED: {
      category: 'COURSE_BUILDING',
      apps: ['INSTRUCTOR'],
      subjectType: 'MEDIA_ASSET',
      label: 'Media processing failed',
      redactable: false,
    },
    CONTENT_HIDDEN: {
      category: 'MODERATION',
      apps: ['STUDENT', 'INSTRUCTOR'],
      subjectType: null,
      label: 'Your post was hidden',
      redactable: false,
    },
    MODERATION_QUEUE: {
      category: 'MODERATION',
      apps: ['ADMIN'],
      subjectType: null,
      label: 'Content auto-hidden',
      redactable: false,
    },
  });

/** `pg_column_size(payload) <= 4096` (§6); snapshot texts are bounded far below it. */
export const NOTIFICATION_PAYLOAD_MAX_BYTES = 4096;
/** Plain-text excerpt of user-authored text (markdown stripped by `plainText()`). */
export const NOTIFICATION_EXCERPT_MAX_CHARS = 280;

/* ----------------------------------------------------------------------------------------
 * Payloads (one per kind). Texts are point-in-time snapshots; redactable texts become null
 * with `redacted: true`.
 * -------------------------------------------------------------------------------------- */

const id = () => z.uuid();
const courseTitle = () => z.string().min(1).max(60);
const personName = () => z.string().min(1).max(80).nullable();
const excerpt = () => z.string().max(NOTIFICATION_EXCERPT_MAX_CHARS).nullable();
const qaTitle = () => z.string().min(1).max(200).nullable();
const redacted = () => z.boolean();

/** Redactable payloads: once redacted, every user-authored text is null. */
function redactionHolds(p: { redacted: boolean }, texts: readonly (string | null)[]): boolean {
  return !p.redacted || texts.every((text) => text === null);
}
const REDACTION = { message: 'A redacted payload carries no user-authored text' };

export const QaNewQuestionPayloadSchema = z
  .object({
    questionId: id(),
    courseId: id(),
    courseTitle: courseTitle(),
    lectureId: id().nullable(),
    questionTitle: qaTitle(),
    authorName: personName(),
    redacted: redacted(),
  })
  .refine((p) => redactionHolds(p, [p.questionTitle]), REDACTION);

export const QaNewAnswerPayloadSchema = z
  .object({
    questionId: id(),
    answerId: id(),
    courseId: id(),
    courseTitle: courseTitle(),
    questionTitle: qaTitle(),
    authorName: personName(),
    /** "Instructor answered" (the answer author owns the course). */
    byInstructor: z.boolean(),
    excerpt: excerpt(),
    redacted: redacted(),
  })
  .refine((p) => redactionHolds(p, [p.questionTitle, p.excerpt]), REDACTION);

/** To the author of the accepted answer. */
export const QaResolvedPayloadSchema = z
  .object({
    questionId: id(),
    answerId: id(),
    courseId: id(),
    courseTitle: courseTitle(),
    questionTitle: qaTitle(),
    redacted: redacted(),
  })
  .refine((p) => redactionHolds(p, [p.questionTitle]), REDACTION);

/** New review, or an edit that changed the rating (`previousRating` set). */
export const ReviewNewPayloadSchema = z
  .object({
    reviewId: id(),
    courseId: id(),
    courseTitle: courseTitle(),
    rating: z.number().int().min(1).max(5),
    previousRating: z.number().int().min(1).max(5).nullable(),
    reviewerName: personName(),
    excerpt: excerpt(),
    redacted: redacted(),
  })
  .refine((p) => redactionHolds(p, [p.excerpt]), REDACTION);

export const ReviewReplyPayloadSchema = z
  .object({
    reviewId: id(),
    courseId: id(),
    courseTitle: courseTitle(),
    instructorName: personName(),
    excerpt: excerpt(),
    redacted: redacted(),
  })
  .refine((p) => redactionHolds(p, [p.excerpt]), REDACTION);

export const AnnouncementPayloadSchema = z
  .object({
    announcementId: id(),
    courseId: id(),
    courseTitle: courseTitle(),
    title: z.string().min(1).max(120).nullable(),
    authorName: personName(),
    redacted: redacted(),
  })
  .refine((p) => redactionHolds(p, [p.title]), REDACTION);

export const CertificateIssuedPayloadSchema = z.object({
  certificateId: id(),
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  courseId: id(),
  courseTitle: courseTitle(),
});

export const MediaReadyPayloadSchema = z.object({
  assetId: id(),
  purpose: MediaPurposeSchema,
  /** Snapshot of the upload's file name. */
  filename: z.string().min(1).max(255).nullable(),
});

export const MediaFailedPayloadSchema = MediaReadyPayloadSchema.extend({
  /** `MediaFailureCode` of the asset. */
  failureCode: z.string().min(1).max(64),
});

/** To the author of hidden content; never quotes it. */
export const ContentHiddenPayloadSchema = z.object({
  subjectType: z.enum(['REVIEW', 'REVIEW_REPLY', 'QUESTION', 'ANSWER']),
  subjectId: id(),
  courseId: id(),
  courseTitle: courseTitle(),
});

/** To admins: the report threshold auto-hid a subject. */
export const ModerationQueuePayloadSchema = z.object({
  subjectType: z.enum(['REVIEW', 'REVIEW_REPLY', 'QUESTION', 'ANSWER']),
  subjectId: id(),
  courseId: id(),
  openReportCount: z.number().int().min(1),
});

/** Payload schema per kind (the worker validates with it before inserting). */
export const NOTIFICATION_PAYLOAD_SCHEMAS = Object.freeze({
  QA_NEW_QUESTION: QaNewQuestionPayloadSchema,
  QA_NEW_ANSWER: QaNewAnswerPayloadSchema,
  QA_RESOLVED: QaResolvedPayloadSchema,
  REVIEW_NEW: ReviewNewPayloadSchema,
  REVIEW_REPLY: ReviewReplyPayloadSchema,
  ANNOUNCEMENT: AnnouncementPayloadSchema,
  CERTIFICATE_ISSUED: CertificateIssuedPayloadSchema,
  MEDIA_READY: MediaReadyPayloadSchema,
  MEDIA_FAILED: MediaFailedPayloadSchema,
  CONTENT_HIDDEN: ContentHiddenPayloadSchema,
  MODERATION_QUEUE: ModerationQueuePayloadSchema,
} satisfies Record<NotificationKind, z.ZodType>);

export type NotificationPayloadOf<K extends NotificationKind> = z.output<
  (typeof NOTIFICATION_PAYLOAD_SCHEMAS)[K]
>;

/** `{ kind, payload }` discriminated by kind: the content part of a notification. */
function content<K extends NotificationKind>(kind: K) {
  return z.object({ kind: z.literal(kind), payload: NOTIFICATION_PAYLOAD_SCHEMAS[kind] });
}

export const NotificationContentSchema = z.discriminatedUnion('kind', [
  content('QA_NEW_QUESTION'),
  content('QA_NEW_ANSWER'),
  content('QA_RESOLVED'),
  content('REVIEW_NEW'),
  content('REVIEW_REPLY'),
  content('ANNOUNCEMENT'),
  content('CERTIFICATE_ISSUED'),
  content('MEDIA_READY'),
  content('MEDIA_FAILED'),
  content('CONTENT_HIDDEN'),
  content('MODERATION_QUEUE'),
]);
export type NotificationContent = z.infer<typeof NotificationContentSchema>;

/** Validates `payload` against the schema of `kind`; throws a ZodError when invalid. */
export function parseNotificationPayload<K extends NotificationKind>(
  kind: K,
  payload: unknown,
): NotificationPayloadOf<K> {
  return NOTIFICATION_PAYLOAD_SCHEMAS[kind].parse(payload) as NotificationPayloadOf<K>;
}

/**
 * The redacted form of a payload (moderation hid its subject): user-authored texts → null.
 * Non-redactable kinds are returned unchanged.
 */
export function redactNotificationPayload(content: NotificationContent): NotificationContent {
  switch (content.kind) {
    case 'QA_NEW_QUESTION':
      return { ...content, payload: { ...content.payload, questionTitle: null, redacted: true } };
    case 'QA_NEW_ANSWER':
      return {
        ...content,
        payload: { ...content.payload, questionTitle: null, excerpt: null, redacted: true },
      };
    case 'QA_RESOLVED':
      return { ...content, payload: { ...content.payload, questionTitle: null, redacted: true } };
    case 'REVIEW_NEW':
      return { ...content, payload: { ...content.payload, excerpt: null, redacted: true } };
    case 'REVIEW_REPLY':
      return { ...content, payload: { ...content.payload, excerpt: null, redacted: true } };
    case 'ANNOUNCEMENT':
      return { ...content, payload: { ...content.payload, title: null, redacted: true } };
    case 'CERTIFICATE_ISSUED':
    case 'MEDIA_READY':
    case 'MEDIA_FAILED':
    case 'CONTENT_HIDDEN':
    case 'MODERATION_QUEUE':
      return content;
  }
}
