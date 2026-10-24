import {
  ErrorCode,
  NotificationPageSchema,
  NotificationPreferencesSchema,
  UNREAD_COUNT_CAP,
  UnreadCountSchema,
} from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../../../shared/errors/rate-limited.error';
import {
  InvalidUnsubscribeToken,
  NotificationNotFound,
  PreferenceLocked,
} from '../../domain/notifications.errors';
import { decodeNotificationCursor } from '../notification-cursor';
import type { InboxOwner } from '../ports/notification.repository';
import {
  FakeRateLimiter,
  FakeUnsubscribeTokenCodec,
  InMemoryNotificationPreferenceRepository,
  InMemoryNotificationRepository,
  RecordingEmitter,
  type StoredNotification,
} from '../testing/notifications.fakes';
import { UnreadCountPublisher } from '../unread-count.publisher';
import { GetNotificationPreferencesQuery } from './get-notification-preferences.query';
import { GetUnreadCountQuery } from './get-unread-count.query';
import { ListNotificationsQuery } from './list-notifications.query';
import { MarkAllNotificationsReadCommand } from './mark-all-notifications-read.command';
import { MarkNotificationReadCommand } from './mark-notification-read.command';
import { UnsubscribeCommand, unsubscribeRateLimitKey } from './unsubscribe.command';
import { UpdateNotificationPreferencesCommand } from './update-notification-preferences.command';

const ALICE = '01900000-0000-7000-8000-0000000000a1';
const BOB = '01900000-0000-7000-8000-0000000000b0';
const COURSE = '01900000-0000-7000-8000-0000000000c1';
const STUDENT_INBOX: InboxOwner = { userId: ALICE, app: 'STUDENT' };
const SECRET = 'u'.repeat(44);

function id(n: number): string {
  return `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

/** A contract-valid ANNOUNCEMENT row for `owner`, created `n` microseconds into the day. */
function announcement(n: number, owner: InboxOwner = STUDENT_INBOX): StoredNotification {
  return {
    id: id(n),
    userId: owner.userId,
    app: owner.app,
    kind: 'ANNOUNCEMENT',
    payload: {
      announcementId: id(1000 + n),
      courseId: COURSE,
      courseTitle: 'Rust for TypeScript developers',
      title: `Week ${n}`,
      authorName: 'Ada',
      redacted: false,
    },
    subjectType: 'ANNOUNCEMENT',
    subjectId: id(1000 + n),
    createdAt: `2026-10-24T10:00:00.${String(n).padStart(6, '0')}Z`,
    readAt: null,
  };
}

function setup() {
  const notifications = new InMemoryNotificationRepository();
  const preferences = new InMemoryNotificationPreferenceRepository();
  const limiter = new FakeRateLimiter();
  const emitter = new RecordingEmitter();
  const publisher = new UnreadCountPublisher(notifications, emitter.asEmitter());
  const codec = new FakeUnsubscribeTokenCodec(SECRET);
  return {
    notifications,
    preferences,
    limiter,
    emitter,
    codec,
    list: new ListNotificationsQuery(notifications),
    count: new GetUnreadCountQuery(notifications),
    markOne: new MarkNotificationReadCommand(notifications, publisher),
    markAll: new MarkAllNotificationsReadCommand(notifications, publisher),
    getPreferences: new GetNotificationPreferencesQuery(preferences),
    updatePreferences: new UpdateNotificationPreferencesCommand(preferences),
    unsubscribe: new UnsubscribeCommand(limiter.asRateLimiter(), codec, preferences),
  };
}

describe('ListNotifications', () => {
  it('pages the own inbox newest first with an exact-timestamp cursor', async () => {
    const t = setup();
    for (const n of [1, 2, 3, 4, 5]) t.notifications.add(announcement(n));
    t.notifications.add(announcement(9, { userId: BOB, app: 'STUDENT' }));
    t.notifications.add({
      ...announcement(8),
      app: 'INSTRUCTOR',
      kind: 'MEDIA_READY',
      payload: { assetId: id(77), purpose: 'LECTURE_VIDEO', filename: 'intro.mp4' },
      subjectType: 'MEDIA_ASSET',
      subjectId: id(77),
    });

    const first = await t.list.execute({ owner: STUDENT_INBOX, unreadOnly: false, limit: 2 });

    expect(NotificationPageSchema.parse(first)).toEqual(first);
    expect(first.items.map((n) => n.id)).toEqual([id(5), id(4)]);
    expect(first.items[0]).toMatchObject({ category: 'ANNOUNCEMENTS', app: 'STUDENT' });
    expect(first.nextCursor).not.toBeNull();
    expect(decodeNotificationCursor(first.nextCursor ?? '')).toEqual({
      createdAt: '2026-10-24T10:00:00.000004Z',
      id: id(4),
    });

    const second = await t.list.execute({
      owner: STUDENT_INBOX,
      unreadOnly: false,
      limit: 3,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((n) => n.id)).toEqual([id(3), id(2), id(1)]);
    expect(second.nextCursor).toBeNull();
  });

  it('filters unread only and skips rows that break the contract', async () => {
    const t = setup();
    t.notifications.add({ ...announcement(1), readAt: new Date('2026-10-24T11:00:00Z') });
    t.notifications.add(announcement(2));
    t.notifications.add({ ...announcement(3), payload: { bogus: true } });

    const page = await t.list.execute({ owner: STUDENT_INBOX, unreadOnly: true, limit: 10 });

    expect(page.items.map((n) => n.id)).toEqual([id(2)]);
  });

  it('rejects a cursor it did not produce (422 validation_failed)', async () => {
    const t = setup();
    await expect(
      t.list.execute({ owner: STUDENT_INBOX, unreadOnly: false, limit: 2, cursor: 'Zm9v' }),
    ).rejects.toMatchObject({ code: ErrorCode.ValidationFailed });
  });
});

describe('UnreadCount', () => {
  it('counts the own unread rows and caps at 100 ("99+")', async () => {
    const t = setup();
    t.notifications.add(announcement(1));
    t.notifications.add(announcement(2, { userId: ALICE, app: 'INSTRUCTOR' }));
    expect(await t.count.execute(STUDENT_INBOX)).toEqual({ count: 1, capped: false });

    for (let n = 10; n < 10 + UNREAD_COUNT_CAP + 5; n += 1) t.notifications.add(announcement(n));
    const capped = await t.count.execute(STUDENT_INBOX);
    expect(capped).toEqual({ count: UNREAD_COUNT_CAP, capped: true });
    expect(UnreadCountSchema.parse(capped)).toEqual(capped);
  });
});

describe('MarkRead / MarkAllRead', () => {
  it('marks one read once, pushes the new count, and is idempotent', async () => {
    const t = setup();
    t.notifications.add(announcement(1));
    t.notifications.add(announcement(2));

    await t.markOne.execute({ owner: STUDENT_INBOX, notificationId: id(2) });
    await t.markOne.execute({ owner: STUDENT_INBOX, notificationId: id(2) });

    expect(t.emitter.emitted).toEqual([
      { room: `u:${ALICE}:STUDENT`, event: 'notification.unread', payload: { count: 1 } },
    ]);
  });

  it('404s a foreign or unknown id, and another app of the same user (IDOR)', async () => {
    const t = setup();
    t.notifications.add(announcement(1, { userId: BOB, app: 'STUDENT' }));
    t.notifications.add(announcement(2, { userId: ALICE, app: 'INSTRUCTOR' }));

    for (const notificationId of [id(1), id(2), id(3)]) {
      await expect(
        t.markOne.execute({ owner: STUDENT_INBOX, notificationId }),
      ).rejects.toBeInstanceOf(NotificationNotFound);
      await expect(
        t.markAll.execute({ owner: STUDENT_INBOX, upToId: notificationId }),
      ).rejects.toBeInstanceOf(NotificationNotFound);
    }
    expect(t.notifications.rows.every((n) => n.readAt === null)).toBe(true);
  });

  it('marks everything up to and including upToId, never newer rows', async () => {
    const t = setup();
    for (const n of [1, 2, 3, 4]) t.notifications.add(announcement(n));

    await t.markAll.execute({ owner: STUDENT_INBOX, upToId: id(3) });

    expect(t.notifications.rows.filter((n) => n.readAt === null).map((n) => n.id)).toEqual([id(4)]);
    expect(t.emitter.emitted.at(-1)?.payload).toEqual({ count: 1 });

    const pushes = t.emitter.emitted.length;
    await t.markAll.execute({ owner: STUDENT_INBOX, upToId: id(3) });
    expect(t.emitter.emitted).toHaveLength(pushes);
  });

  it('a failed push never fails the request', async () => {
    const t = setup();
    t.notifications.add(announcement(1));
    t.emitter.failing = new Error('redis down');

    await expect(
      t.markOne.execute({ owner: STUDENT_INBOX, notificationId: id(1) }),
    ).resolves.toBeUndefined();
  });
});

describe('Preferences', () => {
  it('returns every pair: defaults, overrides and locked MODERATION', async () => {
    const t = setup();
    await t.preferences.upsert(ALICE, [{ category: 'QA', channel: 'EMAIL', enabled: false }]);

    const { items } = NotificationPreferencesSchema.parse(await t.getPreferences.execute(ALICE));

    expect(items).toHaveLength(12);
    expect(items.find((i) => i.category === 'QA' && i.channel === 'EMAIL')).toEqual({
      category: 'QA',
      channel: 'EMAIL',
      enabled: false,
      locked: false,
      isDefault: false,
    });
    expect(
      items.find((i) => i.category === 'COURSE_BUILDING' && i.channel === 'EMAIL'),
    ).toMatchObject({ enabled: false, isDefault: true });
    expect(items.filter((i) => i.locked)).toEqual([
      { category: 'MODERATION', channel: 'IN_APP', enabled: true, locked: true, isDefault: true },
      { category: 'MODERATION', channel: 'EMAIL', enabled: true, locked: true, isDefault: true },
    ]);
  });

  it('updates only the listed pairs', async () => {
    const t = setup();
    const result = await t.updatePreferences.execute({
      userId: ALICE,
      items: [
        { category: 'ANNOUNCEMENTS', channel: 'EMAIL', enabled: false },
        { category: 'COURSE_BUILDING', channel: 'EMAIL', enabled: true },
      ],
    });
    const changed = result.items.filter((i) => !i.isDefault);
    expect(changed).toEqual([
      {
        category: 'ANNOUNCEMENTS',
        channel: 'EMAIL',
        enabled: false,
        locked: false,
        isDefault: false,
      },
      {
        category: 'COURSE_BUILDING',
        channel: 'EMAIL',
        enabled: true,
        locked: false,
        isDefault: false,
      },
    ]);
  });

  it('refuses a locked pair with 422 preference_locked and changes nothing', async () => {
    const t = setup();
    const attempt = t.updatePreferences.execute({
      userId: ALICE,
      items: [
        { category: 'QA', channel: 'EMAIL', enabled: false },
        { category: 'MODERATION', channel: 'EMAIL', enabled: false },
      ],
    });
    await expect(attempt).rejects.toBeInstanceOf(PreferenceLocked);
    await expect(attempt).rejects.toMatchObject({ code: ErrorCode.PreferenceLocked });
    expect(t.preferences.upserts).toBe(0);
  });

  it('a stray stored row never turns a locked pair off', async () => {
    const t = setup();
    await t.preferences.upsert(ALICE, [
      { category: 'MODERATION', channel: 'EMAIL', enabled: false },
    ]);
    const { items } = await t.getPreferences.execute(ALICE);
    expect(items.find((i) => i.category === 'MODERATION' && i.channel === 'EMAIL')).toMatchObject({
      enabled: true,
      locked: true,
    });
  });
});

describe('Unsubscribe', () => {
  const IP = '203.0.113.9';

  it('turns EMAIL off for the token’s category; idempotent', async () => {
    const t = setup();
    const token = t.codec.sign({ userId: ALICE, category: 'ANNOUNCEMENTS' });

    await t.unsubscribe.execute({ token, ip: IP });
    await t.unsubscribe.execute({ token, ip: IP });

    const { items } = await t.getPreferences.execute(ALICE);
    expect(items.filter((i) => !i.isDefault)).toEqual([
      {
        category: 'ANNOUNCEMENTS',
        channel: 'EMAIL',
        enabled: false,
        locked: false,
        isDefault: false,
      },
    ]);
  });

  it.each([
    ['empty', ''],
    ['garbage', 'v1.forged'],
    ['another secret', 'other'],
    ['wrong version', 'v2'],
    ['tampered category', 'tampered'],
  ])('rejects a %s token with invalid_unsubscribe_token', async (_, kind) => {
    const t = setup();
    const genuine = t.codec.sign({ userId: ALICE, category: 'QA' });
    const other = new FakeUnsubscribeTokenCodec('x'.repeat(44)).sign({
      userId: ALICE,
      category: 'QA',
    });
    const token =
      kind === 'other'
        ? other
        : kind === 'v2'
          ? genuine.replace(/^v1\./, 'v2.')
          : kind === 'tampered'
            ? genuine.replace('.QA.', '.REVIEWS.')
            : kind;

    await expect(t.unsubscribe.execute({ token, ip: IP })).rejects.toBeInstanceOf(
      InvalidUnsubscribeToken,
    );
    expect(t.preferences.upserts).toBe(0);
  });

  it('a deleted account is a silent success', async () => {
    const t = setup();
    t.preferences.users.add(BOB);
    const token = t.codec.sign({ userId: ALICE, category: 'QA' });
    await expect(t.unsubscribe.execute({ token, ip: IP })).resolves.toBeUndefined();
  });

  it('counts every attempt per IP (forgeries too) and answers 429 beyond 30 per hour', async () => {
    const t = setup();
    for (let i = 0; i < 30; i += 1) {
      await expect(t.unsubscribe.execute({ token: 'v1.x', ip: IP })).rejects.toBeInstanceOf(
        InvalidUnsubscribeToken,
      );
    }
    const token = t.codec.sign({ userId: ALICE, category: 'QA' });
    await expect(t.unsubscribe.execute({ token, ip: IP })).rejects.toBeInstanceOf(RateLimitedError);
    expect(t.limiter.counts.get(unsubscribeRateLimitKey(IP))).toBe(31);
    await expect(t.unsubscribe.execute({ token, ip: '203.0.113.10' })).resolves.toBeUndefined();
  });
});
