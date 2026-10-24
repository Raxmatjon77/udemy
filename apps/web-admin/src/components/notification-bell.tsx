'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NOTIFICATION_KIND_META, type Notification } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { cn } from '@udemy/ui/lib/utils';

import { formatDateTime } from '@/lib/format';
import {
  describeNotification,
  notificationKeys,
  notificationsApi,
  unreadBadge,
  useNotifications,
  useUnreadCount,
} from '@/lib/notifications';
import { problemMessage } from '@/lib/problem';

function BellIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/**
 * The header bell (Phase 5 design §10): unread badge ("99+" at the cap) and a popover with the
 * newest notifications (keyset "Load more"), an unread-only filter and "Mark all as read".
 * Opening a row marks it read. Escape or a click outside closes the panel and returns focus.
 *
 * The count follows realtime hints (`@udemy/web-realtime`) and polls only without a socket
 * (see src/lib/notifications.ts).
 */
export function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const headingId = useId();
  const count = useUnreadCount();
  const list = useNotifications(unreadOnly, open);

  const refresh = () => queryClient.invalidateQueries({ queryKey: notificationKeys.all });
  const markRead = useMutation({ mutationFn: notificationsApi.markRead, onSettled: refresh });
  const markAllRead = useMutation({ mutationFn: notificationsApi.markAllRead, onSettled: refresh });

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    // On the document: focus may have left the panel (a disabled "Mark all as read").
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const unread = count.data;
  const hasUnread = unread !== undefined && unread.count > 0;
  const label = hasUnread ? `Notifications, ${unreadBadge(unread)} unread` : 'Notifications';
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const newestId = items[0]?.id;
  const error = list.error ?? markAllRead.error ?? markRead.error;

  function select(n: Notification) {
    if (n.readAt === null) markRead.mutate(n.id);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="sm"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="relative"
      >
        <BellIcon />
        {hasUnread ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 min-w-5 rounded-full bg-destructive px-1 text-center text-xs leading-5 font-semibold text-white"
          >
            {unreadBadge(unread)}
          </span>
        ) : null}
      </Button>

      {open ? (
        <section
          id={panelId}
          aria-labelledby={headingId}
          className="absolute right-0 z-50 mt-2 grid w-96 max-w-[calc(100vw-2rem)] gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 id={headingId} className="text-sm font-semibold">
              Notifications
            </h2>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!newestId || !hasUnread || markAllRead.isPending}
              onClick={() => newestId && markAllRead.mutate(newestId)}
            >
              Mark all as read
            </Button>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
            />
            Unread only
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {problemMessage(error)}
            </p>
          ) : null}
          {list.isPending ? (
            <div aria-busy="true" aria-label="Loading notifications" className="grid gap-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {unreadOnly ? 'No unread notifications.' : 'No notifications yet.'}
            </p>
          ) : (
            <ul className="grid max-h-96 gap-1 overflow-y-auto" aria-label="Notification list">
              {items.map((n) => (
                <NotificationRow key={n.id} notification={n} onSelect={() => select(n)} />
              ))}
            </ul>
          )}
          {list.hasNextPage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function NotificationRow({
  notification,
  onSelect,
}: {
  notification: Notification;
  onSelect: () => void;
}) {
  const { title, body, href } = describeNotification(notification);
  const unread = notification.readAt === null;
  const content = (
    <>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {unread ? (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />
        ) : null}
        {NOTIFICATION_KIND_META[notification.kind].label}
        {' · '}
        <time dateTime={notification.createdAt}>{formatDateTime(notification.createdAt)}</time>
        {unread ? <span className="sr-only">(unread)</span> : null}
      </span>
      <span className={cn('text-sm', unread && 'font-medium')}>{title}</span>
      {body ? <span className="line-clamp-2 text-xs text-muted-foreground">{body}</span> : null}
    </>
  );
  const className =
    'grid w-full gap-0.5 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';
  return (
    <li>
      {href ? (
        <Link href={href} onClick={onSelect} className={className}>
          {content}
        </Link>
      ) : (
        <button type="button" onClick={onSelect} className={className}>
          {content}
        </button>
      )}
    </li>
  );
}
