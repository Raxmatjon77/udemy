import { Logger } from '@nestjs/common';
import {
  CertificateReinstated,
  CertificateRevoked,
  ENROLLMENT_ENROLLMENT_AGGREGATE,
  EnrollmentGranted,
  EnrollmentRevoked,
  type EventEnvelope,
} from '@udemy/contracts';
import {
  type DB,
  findCertificateId,
  lockLearningCompletion,
  type Transaction,
  transitionCertificate,
} from '@udemy/db';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { publishEvent } from '../../shared/outbox/publish-event';

/*
 * `learning.certificate-revoker` (design D7, P5-D7, schema doc R13): keeps a certificate in step
 * with its enrollment. Consumer names `learning.certificate-revoker.<event>`.
 *
 * - `EnrollmentRevoked` (any reason) -> REVOKE (cause ENROLLMENT_REVOKED) when ACTIVE.
 * - `EnrollmentGranted {regrant: true}` -> REINSTATE (cause ENROLLMENT_REGRANTED) only when the
 *   last REVOKE was caused by the enrollment. **Admin revocations stick** (user decision, open
 *   point 4): `transitionCertificate` pre-checks the head transition's cause and answers
 *   SKIPPED_ADMIN_REVOKE, with `certificate_transitions_reinstate_cause_ck` as the COMMIT
 *   backstop. The course completion is permanent (the certificate's FK), so it always exists.
 *
 * Both take the `lrnc` mutex of (user, course) first, like the issuer, so an issue racing a
 * revoke is serialised (lock order: lrnc -> certificate row). State-guarded and idempotent: a
 * certificate already in the target status is a NOOP, and every transition writes its outbox
 * event in the same transaction. `revoked_at` is set with SQL now() inside `transitionCertificate`.
 */

@EventHandler(ENROLLMENT_ENROLLMENT_AGGREGATE, EnrollmentRevoked.type, {
  consumerName: 'learning.certificate-revoker.enrollment-revoked',
})
export class CertificateRevokerHandler implements EventHandlerContract {
  private readonly logger = new Logger(CertificateRevokerHandler.name);

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(EnrollmentRevoked, envelope);
    await lockLearningCompletion(trx, event.userId, event.courseId);
    const certificateId = await findCertificateId(trx, event.userId, event.courseId);
    if (certificateId === null) return;
    const result = await transitionCertificate(trx, {
      certificateId,
      action: 'REVOKE',
      cause: 'ENROLLMENT_REVOKED',
      sourceEventId: envelope.eventId,
    });
    if (result.outcome !== 'APPLIED') {
      this.logger.log({ certificateId, outcome: result.outcome }, 'Certificate not revoked');
      return;
    }
    await publishEvent(trx, CertificateRevoked, certificateId, {
      certificateId,
      userId: event.userId,
      courseId: event.courseId,
      actorId: null,
      cause: 'ENROLLMENT_REVOKED',
      revokedAt: result.occurredAt.toISOString(),
    });
    this.logger.log(
      { certificateId, reason: event.reason },
      'Certificate revoked with the enrollment',
    );
  }
}

@EventHandler(ENROLLMENT_ENROLLMENT_AGGREGATE, EnrollmentGranted.type, {
  consumerName: 'learning.certificate-revoker.enrollment-granted',
})
export class CertificateReinstaterHandler implements EventHandlerContract {
  private readonly logger = new Logger(CertificateReinstaterHandler.name);

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(EnrollmentGranted, envelope);
    if (!event.regrant) return; // a first grant has no certificate to reinstate
    await lockLearningCompletion(trx, event.userId, event.courseId);
    const certificateId = await findCertificateId(trx, event.userId, event.courseId);
    if (certificateId === null) return;
    const result = await transitionCertificate(trx, {
      certificateId,
      action: 'REINSTATE',
      cause: 'ENROLLMENT_REGRANTED',
      sourceEventId: envelope.eventId,
    });
    if (result.outcome === 'SKIPPED_ADMIN_REVOKE') {
      this.logger.log({ certificateId }, 'Regrant: an admin revocation sticks; not reinstated');
      return;
    }
    if (result.outcome !== 'APPLIED') return;
    await publishEvent(trx, CertificateReinstated, certificateId, {
      certificateId,
      userId: event.userId,
      courseId: event.courseId,
      actorId: null,
      cause: 'ENROLLMENT_REGRANTED',
      reinstatedAt: result.occurredAt.toISOString(),
    });
    this.logger.log({ certificateId }, 'Certificate reinstated with the regrant');
  }
}
