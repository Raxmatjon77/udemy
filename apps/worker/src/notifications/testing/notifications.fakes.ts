import type {
  NotificationApp,
  NotificationCategory,
  NotificationKind,
  NotificationSubjectType,
  RealtimeServerEvent,
  RealtimeServerEventPayload,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { HmacUnsubscribeTokenCodec } from '@udemy/nest-common/unsubscribe';
import { fakeConfig, RecordingMailer } from '../../identity/testing/identity-mail.fakes';
import type { AdminRecipient } from '../../shared/mail/admin-recipients.reader';
import { AdminRecipientsReader } from '../../shared/mail/admin-recipients.reader';
import { type UserContact, UserContactReader } from '../../shared/mail/user-contact.reader';
import type { RealtimeEmitter } from '../../shared/realtime';
import { NotificationDeliverer } from '../delivery/notification-deliverer';
import {
  type ChannelSwitches,
  effectiveChannels,
  NotificationPreferencesReader,
  type PreferenceOverride,
} from '../delivery/notification-preferences.reader';
import {
  type NewNotificationRow,
  NotificationStore,
  type RedactedNotification,
} from '../delivery/notification.store';
import { NotificationLinks } from '../mail/notification-links';

export const UNSUBSCRIBE_SECRET = 'unit-test-notifications-unsubscribe-secret-0123';

/** The subset of the worker env the notification code reads. */
export function notificationsConfig() {
  return fakeConfig({
    ADMIN_APP_ORIGIN: 'http://localhost:3002',
    NOTIFICATIONS_UNSUBSCRIBE_SECRET: UNSUBSCRIBE_SECRET,
  });
}

export function notificationLinks(): NotificationLinks {
  return new NotificationLinks(
    notificationsConfig(),
    new HmacUnsubscribeTokenCodec(UNSUBSCRIBE_SECRET),
  );
}

export interface EmittedHint {
  room: string;
  event: string;
  payload: unknown;
}

/** Records realtime hints instead of publishing them to Redis. */
export class RecordingRealtime {
  readonly emitted: EmittedHint[] = [];
  readonly left: { fromRoom: string; rooms: string[] }[] = [];

  async emit<E extends RealtimeServerEvent>(
    room: string,
    event: E,
    payload: RealtimeServerEventPayload<E>,
  ): Promise<void> {
    this.emitted.push({ room, event, payload });
  }

  async socketsLeave(fromRoom: string, rooms: readonly string[]): Promise<void> {
    this.left.push({ fromRoom, rooms: [...rooms] });
  }

  asEmitter(): RealtimeEmitter {
    return this as unknown as RealtimeEmitter;
  }
}

export class FakeContacts extends UserContactReader {
  readonly users = new Map<string, UserContact>();

  add(userId: string, displayName = `User ${userId.slice(-4)}`): this {
    this.users.set(userId, { email: `${userId.slice(-4)}@example.test`, displayName });
    return this;
  }

  override async find(_trx: Transaction<DB>, userId: string): Promise<UserContact | null> {
    return this.users.get(userId) ?? null;
  }
}

/** Overrides per `${userId}:${category}`; everything else = code defaults. */
export class FakePreferences extends NotificationPreferencesReader {
  readonly overrides = new Map<string, PreferenceOverride[]>();

  set(
    userId: string,
    category: NotificationCategory,
    channel: 'IN_APP' | 'EMAIL',
    enabled: boolean,
  ): this {
    const key = `${userId}:${category}`;
    this.overrides.set(key, [...(this.overrides.get(key) ?? []), { channel, enabled }]);
    return this;
  }

  override async forUser(
    _trx: Transaction<DB>,
    userId: string,
    category: NotificationCategory,
  ): Promise<ChannelSwitches> {
    return effectiveChannels(category, this.overrides.get(`${userId}:${category}`) ?? []);
  }
}

export interface StoredRow extends NewNotificationRow {
  id: string;
  subjectType: NotificationSubjectType | null;
  redacted: boolean;
}

/** `notifications.notifications` in memory with UNIQUE (user, kind, source event). */
export class FakeStore extends NotificationStore {
  readonly rows: StoredRow[] = [];
  readonly redactions: { subjectType: NotificationSubjectType; subjectIds: string[] }[] = [];
  private next = 1;

  override async insert(_trx: Transaction<DB>, row: NewNotificationRow): Promise<string | null> {
    const exists = this.rows.some(
      (r) =>
        r.userId === row.userId && r.kind === row.kind && r.sourceEventId === row.sourceEventId,
    );
    if (exists) return null;
    const id = `01900000-0000-7000-8000-${String(this.next++).padStart(12, '0')}`;
    this.rows.push({ ...row, id, subjectType: null, redacted: false });
    return id;
  }

  override async countUnread(
    _trx: Transaction<DB>,
    userId: string,
    app: NotificationApp,
    cap: number,
  ): Promise<number> {
    return Math.min(cap, this.rows.filter((r) => r.userId === userId && r.app === app).length);
  }

  override async redactSubjects(
    _trx: Transaction<DB>,
    subjectType: NotificationSubjectType,
    subjectIds: readonly string[],
  ): Promise<RedactedNotification[]> {
    this.redactions.push({ subjectType, subjectIds: [...subjectIds] });
    return [];
  }

  kinds(): NotificationKind[] {
    return this.rows.map((r) => r.kind);
  }
}

export class FakeAdmins extends AdminRecipientsReader {
  constructor(readonly admins: AdminRecipient[] = []) {
    super();
  }

  override async list(): Promise<AdminRecipient[]> {
    return this.admins;
  }
}

export interface DelivererKit {
  contacts: FakeContacts;
  preferences: FakePreferences;
  store: FakeStore;
  mailer: RecordingMailer;
  realtime: RecordingRealtime;
  deliverer: NotificationDeliverer;
}

export function delivererKit(): DelivererKit {
  const contacts = new FakeContacts();
  const preferences = new FakePreferences();
  const store = new FakeStore();
  const mailer = new RecordingMailer();
  const realtime = new RecordingRealtime();
  const deliverer = new NotificationDeliverer(
    contacts,
    preferences,
    store,
    mailer,
    notificationLinks(),
    realtime.asEmitter(),
  );
  return { contacts, preferences, store, mailer, realtime, deliverer };
}
