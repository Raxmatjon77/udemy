'use client';

import type { ReactNode } from 'react';

import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/*
 * The notification bell (Phase 5 design §10): a button with the unread badge that opens a
 * popover. Presentational only: the app renders the list (`children`) and loads the data; the
 * badge shows "99+" when the server capped the count (`capped`).
 */

function NotificationBell({
  count,
  capped = false,
  open,
  onOpenChange,
  children,
  className,
  contentClassName,
}: {
  /** Unread count (0 hides the badge). */
  count: number;
  /** The server's count is capped (`UnreadCount.capped`): show "99+". */
  capped?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const badge = capped || count > 99 ? '99+' : String(count);
  const label =
    count === 0 ? 'Notifications' : `Notifications, ${capped ? 'more than 99' : count} unread`;
  return (
    <Popover {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange } : {})}>
      <PopoverTrigger
        aria-label={label}
        data-slot="notification-bell"
        className={cn(
          'relative inline-flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
          className,
        )}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-5"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count > 0 ? (
          <span
            aria-hidden="true"
            data-testid="notification-badge"
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-white"
          >
            {badge}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Notifications"
        className={cn('w-96 p-0', contentClassName)}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

export { NotificationBell };
