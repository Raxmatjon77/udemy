/**
 * In-memory fakes of the notifications ports for unit tests (no Nest, no DB, no Redis). They
 * model the SQL semantics the use cases rely on: owner scoping by (user, app), keyset order
 * `(created_at DESC, id DESC)`, `read_at` set once, the unread cap, the preference upsert and
 * the unknown-user FK. The real adapters are covered by the e2e spec.
 */
import { createHash } from 'node:crypto';
import type {
  NotificationApp,
  RealtimeServerEvent,
  RealtimeServerEventPayload,
} from '@udemy/contracts';
import type { RealtimeEmitter } from '../../../../shared/realtime';
import type { RateLimiter, RateLimitResult, RateLimitRule } from '../../../../shared/redis';
import type { PreferenceOverride } from '../../domain/notification-preferences';
import {
  formatUnsubscribeToken,
  parseUnsubscribeToken,
  type UnsubscribeTokenClaims,
  unsubscribeMacInput,
} from '../../domain/unsubscribe-token';
import { NotificationPreferenceRepository } from '../ports/notification-preference.repository';
import { UnsubscribeTokenCodec } from '../ports/unsubscribe-token.codec';
import {
  type InboxOwner,
  type InboxPageQuery,
  type MarkReadOutcome,
  NotificationRepository,
  type NotificationRow,
} from '../ports/notification.repository';

export interface StoredNotification {
  id: string;
  userId: string;
  app: NotificationApp;
  kind: string;
  payload: unknown;
  subjectType: string | null;
  subjectId: string | null;
  /** Exact SQL text (microseconds), as the keyset carries it. */
  createdAt: string;
  readAt: Date | null;
}

function owns(owner: InboxOwner, n: StoredNotification): boolean {
  return n.userId === owner.userId && n.app === owner.app;
}

/** Keyset comparison `(created_at, id)`; the fixed-width text sorts like the timestamp. */
function compareKeyset(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export class InMemoryNotificationRepository extends NotificationRepository {
  readonly rows: StoredNotification[] = [];
  now = new Date('2026-10-24T12:00:00.000Z');

  add(row: StoredNotification): StoredNotification {
    this.rows.push(row);
    return row;
  }

  private inbox(owner: InboxOwner): StoredNotification[] {
    return this.rows.filter((n) => owns(owner, n)).sort((a, b) => compareKeyset(b, a));
  }

  listPage(owner: InboxOwner, query: InboxPageQuery): Promise<NotificationRow[]> {
    const after = query.after;
    const rows = this.inbox(owner)
      .filter((n) => !query.unreadOnly || n.readAt === null)
      .filter((n) => after === null || compareKeyset(n, after) < 0)
      .slice(0, query.limit)
      .map((n): NotificationRow => ({
        id: n.id,
        app: n.app,
        kind: n.kind,
        payload: n.payload,
        subjectType: n.subjectType,
        subjectId: n.subjectId,
        createdAt: new Date(n.createdAt),
        readAt: n.readAt,
        keyset: { createdAt: n.createdAt, id: n.id },
      }));
    return Promise.resolve(rows);
  }

  countUnread(owner: InboxOwner, cap: number): Promise<number> {
    return Promise.resolve(
      Math.min(cap, this.inbox(owner).filter((n) => n.readAt === null).length),
    );
  }

  markRead(owner: InboxOwner, notificationId: string): Promise<MarkReadOutcome> {
    const n = this.inbox(owner).find((x) => x.id === notificationId);
    if (n === undefined) return Promise.resolve('not_found');
    if (n.readAt !== null) return Promise.resolve('already_read');
    n.readAt = this.now;
    return Promise.resolve('marked');
  }

  markReadUpTo(owner: InboxOwner, upToId: string): Promise<number | null> {
    const inbox = this.inbox(owner);
    const anchor = inbox.find((x) => x.id === upToId);
    if (anchor === undefined) return Promise.resolve(null);
    let marked = 0;
    for (const n of inbox) {
      if (n.readAt === null && compareKeyset(n, anchor) <= 0) {
        n.readAt = this.now;
        marked += 1;
      }
    }
    return Promise.resolve(marked);
  }
}

export class InMemoryNotificationPreferenceRepository extends NotificationPreferenceRepository {
  readonly rows = new Map<string, PreferenceOverride & { userId: string }>();
  /** Users that exist (the FK); every user exists when empty. */
  readonly users = new Set<string>();
  upserts = 0;

  listOverrides(userId: string): Promise<PreferenceOverride[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.userId === userId)
        .map(({ category, channel, enabled }) => ({ category, channel, enabled })),
    );
  }

  upsert(userId: string, overrides: readonly PreferenceOverride[]): Promise<boolean> {
    if (this.users.size > 0 && !this.users.has(userId)) return Promise.resolve(false);
    this.upserts += 1;
    for (const o of overrides) {
      this.rows.set(`${userId}:${o.category}:${o.channel}`, { userId, ...o });
    }
    return Promise.resolve(true);
  }
}

/** `RateLimiter` stand-in: a fixed-window counter per key, without Redis. */
export class FakeRateLimiter {
  readonly counts = new Map<string, number>();
  failing: Error | undefined;

  hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    if (this.failing !== undefined) return Promise.reject(this.failing);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return Promise.resolve({ count, ttlMs: rule.windowMs, limited: count > rule.limit });
  }

  asRateLimiter(): RateLimiter {
    return this as unknown as RateLimiter;
  }
}

export interface EmittedEvent {
  room: string;
  event: RealtimeServerEvent;
  payload: unknown;
}

/** `RealtimeEmitter` stand-in that records what would be published. */
export class RecordingEmitter {
  readonly emitted: EmittedEvent[] = [];
  failing: Error | undefined;

  emit<E extends RealtimeServerEvent>(
    room: string,
    event: E,
    payload: RealtimeServerEventPayload<E>,
  ): Promise<void> {
    if (this.failing !== undefined) return Promise.reject(this.failing);
    this.emitted.push({ room, event, payload });
    return Promise.resolve();
  }

  asEmitter(): RealtimeEmitter {
    return this as unknown as RealtimeEmitter;
  }
}

/**
 * Unsubscribe tokens in the real v1 format with a keyed SHA-256 instead of HMAC (the HMAC
 * adapter and its constant-time compare have their own spec in infrastructure/).
 */
export class FakeUnsubscribeTokenCodec extends UnsubscribeTokenCodec {
  constructor(private readonly secret: string) {
    super();
  }

  sign(claims: UnsubscribeTokenClaims): string {
    return formatUnsubscribeToken(claims, this.mac(claims));
  }

  verify(token: string): UnsubscribeTokenClaims | null {
    const parsed = parseUnsubscribeToken(token);
    if (parsed === null || parsed.mac !== this.mac(parsed.claims)) return null;
    return parsed.claims;
  }

  private mac(claims: UnsubscribeTokenClaims): string {
    return createHash('sha256')
      .update(`${this.secret}|${unsubscribeMacInput(claims)}`)
      .digest('base64url');
  }
}
