import { Injectable, Logger } from '@nestjs/common';
import {
  NOTIFICATION_KIND_META,
  NOTIFICATION_PAYLOAD_MAX_BYTES,
  type NotificationApp,
  type NotificationContent,
  NotificationContentSchema,
  type NotificationKind,
  type NotificationPayloadOf,
  realtimeUserRoom,
  UNREAD_COUNT_CAP,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { type HandlerContext, NonRetryableError } from '../../messaging';
import { renderMail } from '../../shared/mail/mail-layout';
import { type UserContact, UserContactReader } from '../../shared/mail/user-contact.reader';
import { RealtimeEmitter } from '../../shared/realtime';
import { NotificationLinks } from '../mail/notification-links';
import { notificationMailContent } from '../mail/notification-mail.templates';
import { NotificationPreferencesReader } from './notification-preferences.reader';
import { NotificationStore } from './notification.store';

export interface NotificationDelivery<K extends NotificationKind = NotificationKind> {
  readonly recipientId: string;
  readonly app: NotificationApp;
  readonly kind: K;
  readonly payload: NotificationPayloadOf<K>;
  /** Required iff the kind has a subject type (`NOTIFICATION_KIND_META[kind].subjectType`). */
  readonly subjectId: string | null;
  /** The consumed event (idempotency key with user and kind). */
  readonly sourceEventId: string;
}

export type DeliveryOutcome =
  | { readonly recipient: 'MISSING' }
  | {
      readonly recipient: 'FOUND';
      /** CREATED = a new row (pushed after commit); EXISTS = a replay; OFF = preference. */
      readonly inApp: 'CREATED' | 'EXISTS' | 'OFF';
      readonly notificationId: string | null;
      readonly email: 'SENT' | 'OFF' | 'NONE' | 'SKIPPED';
    };

/**
 * A notification payload that breaks the contract or the table's CHECKs is a builder bug:
 * retrying cannot fix it (design schema §9: `notifications_payload_ck`, `_kind_app_ck`,
 * `_subject_ck` -> DLQ + alert).
 */
export function validateNotification(delivery: NotificationDelivery): NotificationContent {
  const meta = NOTIFICATION_KIND_META[delivery.kind];
  if (!meta.apps.includes(delivery.app)) {
    throw new NonRetryableError(`${delivery.kind} cannot be addressed to the ${delivery.app} app`);
  }
  if ((meta.subjectType === null) !== (delivery.subjectId === null)) {
    throw new NonRetryableError(
      `${delivery.kind} needs ${meta.subjectType === null ? 'no subject' : `a ${meta.subjectType} subject`}`,
    );
  }
  const parsed = NotificationContentSchema.safeParse({
    kind: delivery.kind,
    payload: delivery.payload,
  });
  if (!parsed.success) {
    throw new NonRetryableError(`Invalid ${delivery.kind} payload: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }
  if (
    Buffer.byteLength(JSON.stringify(parsed.data.payload), 'utf8') > NOTIFICATION_PAYLOAD_MAX_BYTES
  ) {
    throw new NonRetryableError(
      `${delivery.kind} payload exceeds ${NOTIFICATION_PAYLOAD_MAX_BYTES} bytes`,
    );
  }
  return parsed.data;
}

/**
 * Fan-out on write for one recipient (design D14, §5 worker notifiers), inside the handler's
 * claim transaction:
 *
 * 1. Validate the payload against contracts (`NotificationContentSchema`) and the kind's app and
 *    subject rules (a violation is non-retryable).
 * 2. Effective preferences of the kind's category (code defaults ⊕ overrides; locked pairs on).
 * 3. IN_APP on: insert the row `ON CONFLICT DO NOTHING`; for a NEW row, register an after-commit
 *    push of `notification.created` + `notification.unread` to `u:{userId}:{app}` (a hint never
 *    announces a row that may roll back).
 * 4. EMAIL on and the kind has a template: send it now, inside the transaction, like every worker
 *    mailer (a send failure rolls back and retries the event; the Message-ID
 *    `<eventId.kind.userId@udemy.local>` is stable so a retried send is deduplicable). Skipped on
 *    a replay (the row already existed). Unlockable categories carry the RFC 8058 headers and
 *    the footer link (design §14).
 */
@Injectable()
export class NotificationDeliverer {
  private readonly logger = new Logger(NotificationDeliverer.name);

  constructor(
    private readonly contacts: UserContactReader,
    private readonly preferences: NotificationPreferencesReader,
    private readonly store: NotificationStore,
    private readonly mailer: Mailer,
    private readonly links: NotificationLinks,
    private readonly realtime: RealtimeEmitter,
  ) {}

  async deliver<K extends NotificationKind>(
    trx: Transaction<DB>,
    context: HandlerContext,
    delivery: NotificationDelivery<K>,
  ): Promise<DeliveryOutcome> {
    const content = validateNotification(delivery);
    const recipient = await this.contacts.find(trx, delivery.recipientId);
    if (recipient === null) {
      this.logger.warn(
        { userId: delivery.recipientId, kind: delivery.kind, eventId: delivery.sourceEventId },
        'Notification for an unknown user; skipped',
      );
      return { recipient: 'MISSING' };
    }
    const category = NOTIFICATION_KIND_META[delivery.kind].category;
    const channels = await this.preferences.forUser(trx, delivery.recipientId, category);

    let notificationId: string | null = null;
    let inApp: 'CREATED' | 'EXISTS' | 'OFF' = 'OFF';
    if (channels.inApp) {
      notificationId = await this.store.insert(trx, {
        userId: delivery.recipientId,
        app: delivery.app,
        kind: delivery.kind,
        payload: content.payload,
        subjectId: delivery.subjectId,
        sourceEventId: delivery.sourceEventId,
      });
      inApp = notificationId === null ? 'EXISTS' : 'CREATED';
      if (notificationId !== null) {
        const count = await this.store.countUnread(
          trx,
          delivery.recipientId,
          delivery.app,
          UNREAD_COUNT_CAP,
        );
        const id = notificationId;
        context.afterCommit(() =>
          this.push(delivery.recipientId, delivery.app, { id, kind: delivery.kind, count }),
        );
      }
    }

    let email: 'SENT' | 'OFF' | 'NONE' | 'SKIPPED' = 'OFF';
    if (channels.email) {
      if (inApp === 'EXISTS') {
        email = 'SKIPPED';
      } else {
        const sent = await this.sendMail(
          recipient,
          delivery.recipientId,
          delivery.app,
          content,
          `${delivery.sourceEventId}.${delivery.kind.toLowerCase()}.${delivery.recipientId}`,
        );
        email = sent ? 'SENT' : 'NONE';
      }
    }
    return { recipient: 'FOUND', inApp, notificationId, email };
  }

  /**
   * Renders and sends the e-mail of `content` to one recipient (also used by the FanoutJob
   * after its batch committed). false = the kind has no e-mail template.
   */
  async sendMail(
    recipient: UserContact,
    userId: string,
    app: NotificationApp,
    content: NotificationContent,
    messageKey: string,
  ): Promise<boolean> {
    const mail = notificationMailContent(content, app, this.links);
    if (mail === null) return false;
    const category = NOTIFICATION_KIND_META[content.kind].category;
    const token = this.links.unsubscribeToken(userId, category);
    const rendered = renderMail({
      subject: mail.subject,
      greetingName: recipient.displayName,
      paragraphs: mail.paragraphs,
      action: mail.action,
      ...(token === null ? {} : { unsubscribe: this.links.footer(token, category) }),
    });
    await this.mailer.send({
      to: recipient.email,
      ...rendered,
      messageId: eventMessageId(messageKey),
      ...(token === null ? {} : { headers: { ...this.links.headers(token) } }),
    });
    return true;
  }

  /** `notification.created` (+ the unread count) to the recipient's user room. */
  async push(
    userId: string,
    app: NotificationApp,
    created: { id: string; kind: NotificationKind; count?: number },
  ): Promise<void> {
    const room = realtimeUserRoom(userId, app);
    await this.realtime.emit(room, 'notification.created', {
      id: created.id,
      kind: created.kind,
      app,
    });
    if (created.count !== undefined) {
      await this.realtime.emit(room, 'notification.unread', { count: created.count });
    }
  }
}
