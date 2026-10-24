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
 * The notification inbox of the instructor app (Phase 5 design §8 "Notifications", §10 bell):
 * new questions and answers, new reviews, media processing results and moderation notices.
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

function qaHref(courseId: string, status: 'unanswered' | 'all' = 'all'): string {
  return `/qa${queryString({ courseId, status })}`;
}

/**
 * Plain-text wording of one inbox row (payloads are snapshots, rendered as React text, never as
 * HTML). Redacted payloads carry no user-authored text.
 */
export function describeNotification(n: Notification): NotificationText {
  switch (n.kind) {
    case 'QA_NEW_QUESTION': {
      const p = n.payload;
      return {
        title: `New question in ${p.courseTitle}`,
        body: p.redacted
          ? HIDDEN_TEXT
          : `${p.authorName ?? 'A former student'} asked ${quoted(p.questionTitle)}`,
        href: qaHref(p.courseId, 'unanswered'),
      };
    }
    case 'QA_NEW_ANSWER': {
      const p = n.payload;
      return {
        title: `New answer in ${p.courseTitle}`,
        body: p.redacted
          ? HIDDEN_TEXT
          : `${p.authorName ?? 'A former student'} answered ${quoted(p.questionTitle)}${
              p.excerpt ? `: ${p.excerpt}` : ''
            }`,
        href: qaHref(p.courseId),
      };
    }
    case 'QA_RESOLVED': {
      const p = n.payload;
      return {
        title: 'Your answer was accepted',
        body: p.redacted ? HIDDEN_TEXT : `${quoted(p.questionTitle)} in ${p.courseTitle}`,
        href: qaHref(p.courseId),
      };
    }
    case 'REVIEW_NEW': {
      const p = n.payload;
      return {
        title:
          p.previousRating === null
            ? `New ${p.rating}-star review of ${p.courseTitle}`
            : `A review of ${p.courseTitle} changed from ${p.previousRating} to ${p.rating} stars`,
        body: p.redacted
          ? HIDDEN_TEXT
          : `${p.reviewerName ?? 'A former student'}${p.excerpt ? `: ${p.excerpt}` : ''}`,
        href: `/courses/${encodeURIComponent(p.courseId)}?tab=reviews`,
      };
    }
    case 'REVIEW_REPLY': {
      const p = n.payload;
      return {
        title: `Reply to a review of ${p.courseTitle}`,
        body: p.redacted ? HIDDEN_TEXT : p.excerpt,
        href: `/courses/${encodeURIComponent(p.courseId)}?tab=reviews`,
      };
    }
    case 'ANNOUNCEMENT': {
      const p = n.payload;
      return {
        title: `Announcement in ${p.courseTitle}`,
        body: p.redacted ? HIDDEN_TEXT : p.title,
        href: `/courses/${encodeURIComponent(p.courseId)}?tab=announcements`,
      };
    }
    case 'CERTIFICATE_ISSUED':
      return {
        title: NOTIFICATION_KIND_META.CERTIFICATE_ISSUED.label,
        body: n.payload.courseTitle,
        href: null,
      };
    case 'MEDIA_READY':
      return {
        title: `${n.payload.filename ?? 'Your upload'} is ready`,
        body: 'Processing finished. It can be used in your course now.',
        href: null,
      };
    case 'MEDIA_FAILED': {
      const code = n.payload.failureCode;
      return {
        title: `${n.payload.filename ?? 'Your upload'} could not be processed`,
        body:
          code in MEDIA_FAILURE_LABELS
            ? MEDIA_FAILURE_LABELS[code as MediaFailureCode]
            : 'Upload the file again.',
        href: null,
      };
    }
    case 'CONTENT_HIDDEN': {
      const p = n.payload;
      return {
        title: `Your ${SUBJECT_LABELS[p.subjectType]} in ${p.courseTitle} was hidden`,
        body: 'A moderator hid it. Contact support if you think this is a mistake.',
        href:
          p.subjectType === 'QUESTION' || p.subjectType === 'ANSWER'
            ? qaHref(p.courseId)
            : `/courses/${encodeURIComponent(p.courseId)}?tab=reviews`,
      };
    }
    case 'MODERATION_QUEUE':
      return {
        title: `A ${SUBJECT_LABELS[n.payload.subjectType]} was hidden automatically`,
        body: `${n.payload.openReportCount} open reports`,
        href: null,
      };
  }
}
