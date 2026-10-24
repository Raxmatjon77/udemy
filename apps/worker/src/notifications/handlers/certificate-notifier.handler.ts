import { Logger } from '@nestjs/common';
import {
  CertificateIssued,
  type EventEnvelope,
  LEARNING_CERTIFICATE_AGGREGATE,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import {
  EventHandler,
  type EventHandlerContract,
  type HandlerContext,
  parseEvent,
} from '../../messaging';
import { NotificationDeliverer } from '../delivery/notification-deliverer';
import { NotificationContextReader } from '../persistence/notification-context.reader';

/**
 * `notifications.certificate-notifier`: `CertificateIssued` -> CERTIFICATE_ISSUED to the learner
 * (STUDENT, LEARNING category: in-app and e-mail with the verification link). The payload carries
 * the certificate's snapshot title. A certificate that is no longer ACTIVE by the time the event
 * is handled (the issuer revoked it at once because the enrollment was already revoked) is not
 * announced.
 */
@EventHandler(LEARNING_CERTIFICATE_AGGREGATE, CertificateIssued.type, {
  consumerName: 'notifications.certificate-notifier',
})
export class CertificateIssuedNotifier implements EventHandlerContract {
  private readonly logger = new Logger(CertificateIssuedNotifier.name);

  constructor(
    private readonly reader: NotificationContextReader,
    private readonly deliverer: NotificationDeliverer,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(CertificateIssued, envelope);
    const certificate = await this.reader.certificate(trx, event.certificateId);
    if (certificate === null || certificate.status !== 'ACTIVE') {
      this.logger.log(
        { certificateId: event.certificateId, status: certificate?.status ?? null },
        'Certificate missing or not active; no notification',
      );
      return;
    }
    await this.deliverer.deliver(trx, context, {
      recipientId: certificate.userId,
      app: 'STUDENT',
      kind: 'CERTIFICATE_ISSUED',
      subjectId: certificate.id,
      sourceEventId: envelope.eventId,
      payload: {
        certificateId: certificate.id,
        code: certificate.publicCode,
        courseId: certificate.courseId,
        courseTitle: certificate.courseTitle,
      },
    });
  }
}
