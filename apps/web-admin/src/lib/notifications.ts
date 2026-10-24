import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  MEDIA_FAILURE_LABELS,
  NOTIFICATION_KIND_META,
  NotificationPageSchema,
  UnreadCountSchema,
  type MediaFailureCode,
  type Notification,
  type NotificationPage,
  type UnreadCount,
} from '@udemy/contracts';
import { useLiveRefetchInterval } from '@udemy/web-realtime';

import { api, queryString } from './api';

/*
 * The notification inbox of the admin console (Phase 5 design §8 "Notifications", §10 bell):
 * `MODERATION_QUEUE` (the report threshold auto-hid a subject). The other kinds are never
 * addressed to the ADMIN app; they are worded anyway so an unexpected row still renders.
 */

/**
 * Query keys. Everything lives under `['notifications']`: the realtime client
 * (`@udemy/web-realtime`) invalidates exactly that prefix on `notification.*` events.
 */
export const notificationKeys = {
  all: ['notifications'] as const,
  unreadCount: ['notifications', 'unread-count'] as const,
  list: (unreadOnly: boolean) => ['notifications', 'list', { unreadOnly }] as const,
};

/**
 * Polling fallback of the unread count. With the realtime socket connected
 * (`@udemy/web-realtime` `RealtimeProvider`, see app/providers.tsx) the count is not polled:
 * `notification.created` / `notification.unread` invalidate `['notifications']` instead.
 * Without a socket (no `REALTIME_PUBLIC_URL`, ticket 429/503, reconnecting) it polls.
 */
export const UNREAD_POLL_MS = 30_000;

const PAGE_SIZE = 10;

export const notificationsApi = {
  list: (params: { unreadOnly: boolean; cursor: string | null }): Promise<NotificationPage> =>
    api(
      `/me/notifications${queryString({
        unreadOnly: params.unreadOnly ? 'true' : undefined,
        cursor: params.cursor,
        limit: PAGE_SIZE,
      })}`,
      { schema: NotificationPageSchema },
    ),
  unreadCount: (): Promise<UnreadCount> =>
    api('/me/notifications/unread-count', { schema: UnreadCountSchema, quiet: true }),
  markRead: (id: string): Promise<void> =>
    api(`/me/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  markAllRead: (upToId: string): Promise<void> =>
    api('/me/notifications/read-all', { method: 'POST', json: { upToId } }),
};

export function useUnreadCount() {
  const refetchInterval = useLiveRefetchInterval(UNREAD_POLL_MS);
  return useQuery({
    queryKey: notificationKeys.unreadCount,
    queryFn: notificationsApi.unreadCount,
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function useNotifications(unreadOnly: boolean, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: notificationKeys.list(unreadOnly),
    queryFn: ({ pageParam }) => notificationsApi.list({ unreadOnly, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 0,
  });
}

/** "3", or "99+" at the cap. */
export function unreadBadge(count: UnreadCount): string {
  return count.capped ? '99+' : String(count.count);
}

export interface NotificationText {
  title: string;
  body: string | null;
  /** Where the row leads in this app, or null (nothing to open). */
  href: string | null;
}

const SUBJECT_LABELS = {
  REVIEW: 'review',
  REVIEW_REPLY: 'reply to a review',
  QUESTION: 'question',
  ANSWER: 'answer',
} as const;

const HIDDEN_TEXT = 'This content was hidden by moderation.';

function quoted(text: string | null): string {
  return text === null ? 'a question' : `“${text}”`;
}

/**
 * Plain-text wording of one inbox row (payloads are snapshots, rendered as React text, never as
 * HTML). Redacted payloads carry no user-authored text. Only `MODERATION_QUEUE` leads somewhere
 * in this app (the moderation queue filtered to the subject type).
 */
export function describeNotification(n: Notification): NotificationText {
  switch (n.kind) {
    case 'MODERATION_QUEUE':
      return {
        title: `A ${SUBJECT_LABELS[n.payload.subjectType]} was hidden automatically`,
        body: `${n.payload.openReportCount} open reports. Review the decision.`,
        href: `/moderation${queryString({ type: n.payload.subjectType })}`,
      };
    case 'QA_NEW_QUESTION':
      return {
        title: `New question in ${n.payload.courseTitle}`,
        body: n.payload.redacted ? HIDDEN_TEXT : quoted(n.payload.questionTitle),
        href: null,
      };
    case 'QA_NEW_ANSWER':
      return {
        title: `New answer in ${n.payload.courseTitle}`,
        body: n.payload.redacted ? HIDDEN_TEXT : quoted(n.payload.questionTitle),
        href: null,
      };
    case 'QA_RESOLVED':
      return { title: 'Answer accepted', body: n.payload.courseTitle, href: null };
    case 'REVIEW_NEW':
      return {
        title: `New ${n.payload.rating}-star review of ${n.payload.courseTitle}`,
        body: n.payload.redacted ? HIDDEN_TEXT : n.payload.excerpt,
        href: null,
      };
    case 'REVIEW_REPLY':
      return {
        title: `Reply to a review of ${n.payload.courseTitle}`,
        body: n.payload.redacted ? HIDDEN_TEXT : n.payload.excerpt,
        href: null,
      };
    case 'ANNOUNCEMENT':
      return {
        title: `Announcement in ${n.payload.courseTitle}`,
        body: n.payload.redacted ? HIDDEN_TEXT : n.payload.title,
        href: null,
      };
    case 'CERTIFICATE_ISSUED':
      return {
        title: NOTIFICATION_KIND_META.CERTIFICATE_ISSUED.label,
        body: n.payload.courseTitle,
        href: null,
      };
    case 'MEDIA_READY':
      return { title: `${n.payload.filename ?? 'An upload'} is ready`, body: null, href: null };
    case 'MEDIA_FAILED': {
      const code = n.payload.failureCode;
      return {
        title: `${n.payload.filename ?? 'An upload'} could not be processed`,
        body: code in MEDIA_FAILURE_LABELS ? MEDIA_FAILURE_LABELS[code as MediaFailureCode] : null,
        href: null,
      };
    }
    case 'CONTENT_HIDDEN':
      return {
        title: `A ${SUBJECT_LABELS[n.payload.subjectType]} in ${n.payload.courseTitle} was hidden`,
        body: null,
        href: null,
      };
  }
}
