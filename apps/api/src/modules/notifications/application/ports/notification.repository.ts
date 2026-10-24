import type { NotificationApp } from '@udemy/contracts';

/**
 * Keyset of the inbox `(created_at DESC, id DESC)`. `createdAt` is the exact SQL text (UTC,
 * microseconds): a JS Date would drop the microseconds and skip rows (P2 design §14).
 */
export interface NotificationKeyset {
  readonly createdAt: string;
  readonly id: string;
}

/** A `notifications.notifications` row as the inbox reads it (payload not yet validated). */
export interface NotificationRow {
  readonly id: string;
  readonly app: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly createdAt: Date;
  readonly readAt: Date | null;
  readonly keyset: NotificationKeyset;
}

/** Who owns an inbox: one user's rows for one app audience (design D14). */
export interface InboxOwner {
  readonly userId: string;
  readonly app: NotificationApp;
}

export interface InboxPageQuery {
  readonly unreadOnly: boolean;
  readonly after: NotificationKeyset | null;
  readonly limit: number;
}

/** Outcome of marking one notification read. */
export type MarkReadOutcome = 'marked' | 'already_read' | 'not_found';

/**
 * The inbox of `notifications.notifications`. Every method is scoped to ONE owner
 * (`user_id` AND `app`), so a foreign id behaves exactly like an unknown one (IDOR-safe).
 * Rows are written by the worker; the api only reads them and sets `read_at` once (the
 * `notifications_immutable_trg` trigger forbids every other change).
 */
export abstract class NotificationRepository {
  /** Newest first; `limit` rows at most (the caller asks for one more to detect a next page). */
  abstract listPage(owner: InboxOwner, query: InboxPageQuery): Promise<NotificationRow[]>;

  /** Unread rows, counted up to `cap` (`count(*)` over a `LIMIT cap` subquery). */
  abstract countUnread(owner: InboxOwner, cap: number): Promise<number>;

  /** Sets `read_at = now()` once. */
  abstract markRead(owner: InboxOwner, notificationId: string): Promise<MarkReadOutcome>;

  /**
   * Marks every unread row at or before `upToId` in keyset order read. Returns the number of
   * rows it marked, or null when `upToId` is not in the owner's inbox.
   */
  abstract markReadUpTo(owner: InboxOwner, upToId: string): Promise<number | null>;
}
