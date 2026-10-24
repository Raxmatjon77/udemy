import {
  NotificationPageSchema,
  NotificationPreferencesSchema,
  UnreadCountSchema,
  type NotificationPage,
  type NotificationPreferences,
  type UnreadCount,
  type UpdateNotificationPreferencesRequest,
} from '@udemy/contracts';
import { REALTIME_QUERY_ROOTS } from '@udemy/web-realtime';

import { api, queryString } from '../api';

/**
 * Browser calls of the notification routes (learning experience design §8 "Notifications").
 * Every key starts with `['notifications']` (`REALTIME_QUERY_ROOTS.notifications`), so the
 * realtime hints `notification.created` / `notification.unread` invalidate them all.
 */
export const notificationKeys = {
  all: REALTIME_QUERY_ROOTS.notifications,
  unread: [...REALTIME_QUERY_ROOTS.notifications, 'unread-count'] as const,
  list: [...REALTIME_QUERY_ROOTS.notifications, 'list'] as const,
  preferences: [...REALTIME_QUERY_ROOTS.notifications, 'preferences'] as const,
};

export function fetchUnreadCount(signal?: AbortSignal): Promise<UnreadCount> {
  return api('/me/notifications/unread-count', {
    schema: UnreadCountSchema,
    quiet: true,
    ...(signal ? { signal } : {}),
  });
}

export function fetchNotifications(
  cursor: string | null,
  signal?: AbortSignal,
): Promise<NotificationPage> {
  return api(`/me/notifications${queryString({ cursor })}`, {
    schema: NotificationPageSchema,
    quiet: true,
    ...(signal ? { signal } : {}),
  });
}

export function markNotificationRead(notificationId: string): Promise<void> {
  return api(`/me/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST' });
}

/** Marks every notification up to (and including, in list order) `upToId` read. */
export function markAllNotificationsRead(upToId: string): Promise<void> {
  return api('/me/notifications/read-all', { method: 'POST', json: { upToId } });
}

export function fetchPreferences(signal?: AbortSignal): Promise<NotificationPreferences> {
  return api('/me/notification-preferences', {
    schema: NotificationPreferencesSchema,
    ...(signal ? { signal } : {}),
  });
}

export function updatePreferences(
  body: UpdateNotificationPreferencesRequest,
): Promise<NotificationPreferences> {
  return api('/me/notification-preferences', {
    method: 'PUT',
    json: body,
    schema: NotificationPreferencesSchema,
  });
}

/** One-click unsubscribe (public, `{token}` from the e-mail link's fragment). */
export function unsubscribe(token: string): Promise<void> {
  return api('/notifications/unsubscribe', { method: 'POST', json: { token }, quiet: true });
}
