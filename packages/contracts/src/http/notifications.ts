import { z } from 'zod';
import {
  NOTIFICATION_PAYLOAD_SCHEMAS,
  NotificationAppSchema,
  NotificationCategorySchema,
  NotificationChannelSchema,
  type NotificationKind,
  NotificationSubjectTypeSchema,
} from '../notifications/notification-kinds';
import type { RateLimitRule } from './learning';
import { IsoDateTimeSchema, UuidSchema } from './fields';
import { booleanQueryParam, CompactPaginationQuerySchema, pageSchema } from './pagination';

/**
 * Notifications REST (Phase 5 learning experience design D14, §5 notifications, §8). All three
 * BFFs serve these routes; the inbox is scoped to the principal's app (`app` claim).
 *
 *   GET  /me/notifications?unreadOnly=&cursor=&limit= -> 200 NotificationPage (P notification:manage:own; 400)
 *   GET  /me/notifications/unread-count               -> 200 UnreadCount
 *   POST /me/notifications/:notificationId/read       -> 204 (404 notification_not_found; idempotent)
 *   POST /me/notifications/read-all {upToId}          -> 204 (404; marks every row ≤ upToId read)
 *   GET  /me/notification-preferences                 -> 200 NotificationPreferences
 *   PUT  /me/notification-preferences {items}         -> 200 NotificationPreferences (422 preference_locked)
 *   POST /notifications/unsubscribe {token}           -> 204 (public, C + @Public; 400 invalid_unsubscribe_token, 429)
 * Keyset (createdAt DESC, id DESC).
 */

export const NOTIFICATION_RATE_LIMITS = Object.freeze({
  unsubscribe: { limit: 30, windowSeconds: 3600, per: 'ip' },
  /** `POST /realtime/tickets`. */
  realtimeTicket: { limit: 30, windowSeconds: 600, per: 'user' },
} as const satisfies Record<string, RateLimitRule>);

/** `count(*) … LIMIT 100`: a count of 100 is shown as "99+". */
export const UNREAD_COUNT_CAP = 100;

/** Rows older than this are deleted by `NotificationRetentionJob`. */
export const NOTIFICATION_RETENTION_DAYS = 180;

export const NotificationIdParamsSchema = z.object({ notificationId: UuidSchema });
export type NotificationIdParams = z.output<typeof NotificationIdParamsSchema>;

export const NotificationsQuerySchema = CompactPaginationQuerySchema.extend({
  unreadOnly: booleanQueryParam(false),
});
export type NotificationsQuery = z.output<typeof NotificationsQuerySchema>;

const notificationBase = {
  id: UuidSchema,
  app: NotificationAppSchema,
  category: NotificationCategorySchema,
  subjectType: NotificationSubjectTypeSchema.nullable(),
  subjectId: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  readAt: IsoDateTimeSchema.nullable(),
};

function notificationOf<K extends NotificationKind>(kind: K) {
  return z.object({
    ...notificationBase,
    kind: z.literal(kind),
    payload: NOTIFICATION_PAYLOAD_SCHEMAS[kind],
  });
}

/** One inbox row; narrowing on `kind` narrows `payload`. */
export const NotificationSchema = z.discriminatedUnion('kind', [
  notificationOf('QA_NEW_QUESTION'),
  notificationOf('QA_NEW_ANSWER'),
  notificationOf('QA_RESOLVED'),
  notificationOf('REVIEW_NEW'),
  notificationOf('REVIEW_REPLY'),
  notificationOf('ANNOUNCEMENT'),
  notificationOf('CERTIFICATE_ISSUED'),
  notificationOf('MEDIA_READY'),
  notificationOf('MEDIA_FAILED'),
  notificationOf('CONTENT_HIDDEN'),
  notificationOf('MODERATION_QUEUE'),
]);
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationPageSchema = pageSchema(NotificationSchema);
export type NotificationPage = z.infer<typeof NotificationPageSchema>;

export const UnreadCountSchema = z
  .object({
    /** 0–100; 100 together with `capped` means "99+". */
    count: z.number().int().min(0).max(UNREAD_COUNT_CAP),
    capped: z.boolean(),
  })
  .refine((c) => c.capped === c.count >= UNREAD_COUNT_CAP, {
    message: 'capped is true exactly at the cap',
    path: ['capped'],
  });
export type UnreadCount = z.infer<typeof UnreadCountSchema>;

export const MarkAllReadRequestSchema = z.object({ upToId: UuidSchema });
export type MarkAllReadRequest = z.output<typeof MarkAllReadRequestSchema>;

/* ----------------------------------------------------------------------------------------
 * Preferences: effective value = code default (`NOTIFICATION_CATEGORY_META`) ⊕ the stored
 * override. Locked (transactional) pairs cannot be changed (422 `preference_locked`).
 * -------------------------------------------------------------------------------------- */

export const NotificationPreferenceSchema = z.object({
  category: NotificationCategorySchema,
  channel: NotificationChannelSchema,
  enabled: z.boolean(),
  locked: z.boolean(),
  /** No stored override: the code default applies. */
  isDefault: z.boolean(),
});
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;

/** Every (category, channel) pair, in `NOTIFICATION_CATEGORIES` × `NOTIFICATION_CHANNELS` order. */
export const NotificationPreferencesSchema = z.object({
  items: z.array(NotificationPreferenceSchema),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

/** A partial update: only the listed pairs change. */
export const UpdateNotificationPreferencesRequestSchema = z.object({
  items: z
    .array(
      z.object({
        category: NotificationCategorySchema,
        channel: NotificationChannelSchema,
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(12)
    .refine(
      (items) => new Set(items.map((i) => `${i.category}:${i.channel}`)).size === items.length,
      { message: 'Each (category, channel) pair may appear once' },
    ),
});
export type UpdateNotificationPreferencesRequest = z.output<
  typeof UpdateNotificationPreferencesRequestSchema
>;

/* ----------------------------------------------------------------------------------------
 * One-click unsubscribe (RFC 8058): the web page reads the `#token` fragment and POSTs it.
 * The token is `HMAC(NOTIFICATIONS_UNSUBSCRIBE_SECRET, v1|userId|category)` plus its fields;
 * it turns EMAIL off for one category. Idempotent.
 * -------------------------------------------------------------------------------------- */

export const UnsubscribeRequestSchema = z.object({ token: z.string().min(1).max(512) });
export type UnsubscribeRequest = z.output<typeof UnsubscribeRequestSchema>;
