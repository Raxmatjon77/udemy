'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import type { Notification, NotificationPage } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { NotificationBell } from '@udemy/ui/components/notification-bell';
import { cn } from '@udemy/ui/lib/utils';
import { useLiveRefetchInterval } from '@udemy/web-realtime';
import Link from 'next/link';
import { useState } from 'react';

import { formatRelative } from '@/lib/format';
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  notificationKeys,
} from '@/lib/notifications/client';
import { describeNotification } from '@/lib/notifications/describe';
import { problemMessage } from '@/lib/problem';

/**
 * The header bell (design §10): the unread count (capped "99+") and, when opened, the newest
 * notifications with keyset "Load more". Realtime hints (`notification.created` / `.unread`)
 * invalidate `['notifications']` through `RealtimeProvider`; without a socket the count polls.
 */

/** Unread-count polling when there is no live socket. */
export const NOTIFICATIONS_POLL_MS = 30_000;

export function HeaderNotifications() {
  const [open, setOpen] = useState(false);
  const refetchInterval = useLiveRefetchInterval(NOTIFICATIONS_POLL_MS);
  const unread = useQuery({
    queryKey: notificationKeys.unread,
    queryFn: ({ signal }) => fetchUnreadCount(signal),
    refetchInterval,
    staleTime: 15_000,
  });

  return (
    <NotificationBell
      count={unread.data?.count ?? 0}
      capped={unread.data?.capped ?? false}
      open={open}
      onOpenChange={setOpen}
    >
      {open ? <NotificationList onNavigate={() => setOpen(false)} /> : null}
    </NotificationBell>
  );
}

function NotificationList({ onNavigate }: { onNavigate: () => void }) {
  const queryClient = useQueryClient();
  const list = useInfiniteQuery<
    NotificationPage,
    Error,
    InfiniteData<NotificationPage, string | null>,
    typeof notificationKeys.list,
    string | null
  >({
    queryKey: notificationKeys.list,
    queryFn: ({ pageParam, signal }) => fetchNotifications(pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: notificationKeys.all });
  const markOne = useMutation({ mutationFn: markNotificationRead, onSettled: refresh });
  const markAll = useMutation({ mutationFn: markAllNotificationsRead, onSettled: refresh });

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const newest = items[0];
  const anyUnread = items.some((n) => n.readAt === null);

  return (
    <div className="flex max-h-[70dvh] flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Notifications</h2>
        <div className="flex items-center gap-1">
          {newest && anyUnread ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={markAll.isPending}
              onClick={() => markAll.mutate(newest.id)}
            >
              Mark all as read
            </Button>
          ) : null}
          <Button asChild size="sm" variant="ghost">
            <Link href="/account/notifications" onClick={onNavigate}>
              Settings
            </Link>
          </Button>
        </div>
      </div>
      <div className="overflow-y-auto">
        {list.isPending ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading…
          </p>
        ) : list.isError ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            {problemMessage(list.error)}
          </p>
        ) : items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">You have no notifications.</p>
        ) : (
          <ul aria-label="Notifications" className="divide-y">
            {items.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onOpen={() => {
                  if (notification.readAt === null) markOne.mutate(notification.id);
                  onNavigate();
                }}
              />
            ))}
          </ul>
        )}
        {list.hasNextPage ? (
          <div className="p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NotificationItem({
  notification,
  onOpen,
}: {
  notification: Notification;
  onOpen: () => void;
}) {
  const view = describeNotification(notification);
  const unread = notification.readAt === null;
  const body = (
    <>
      <span className="flex items-center gap-2 text-xs font-medium">
        {unread ? (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />
        ) : null}
        {view.title}
        {unread ? <span className="sr-only">(unread)</span> : null}
        <time
          dateTime={notification.createdAt}
          className="ml-auto font-normal text-muted-foreground"
        >
          {formatRelative(notification.createdAt)}
        </time>
      </span>
      <span className="text-sm">{view.text}</span>
    </>
  );
  const className = cn(
    'flex w-full flex-col gap-1 px-4 py-3 text-left outline-none hover:bg-accent focus-visible:bg-accent',
    unread && 'bg-primary/5',
  );
  return (
    <li data-testid="notification" data-unread={unread || undefined}>
      {view.href ? (
        <Link href={view.href} className={className} onClick={onOpen}>
          {body}
        </Link>
      ) : (
        <button type="button" className={className} onClick={onOpen}>
          {body}
        </button>
      )}
    </li>
  );
}
