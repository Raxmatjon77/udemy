import { Logger } from '@nestjs/common';
import {
  CertificateIssued,
  CertificateRevoked,
  CourseCompleted,
  type EventEnvelope,
  LEARNING_PROGRESS_AGGREGATE,
} from '@udemy/contracts';
import {
  type DB,
  issueCertificate,
  type IssueCertificateResult,
  lockLearningCompletion,
  type Transaction,
  transitionCertificate,
} from '@udemy/db';
import {
  EventHandler,
  type EventHandlerContract,
  type HandlerContext,
  NonRetryableError,
  parseEvent,
} from '../../messaging';
import { publishEvent } from '../../shared/outbox/publish-event';
import { newCertificateCode } from '../certificates/certificate-code';
import { CertificatePdfPublisher } from '../certificates/certificate-pdf.publisher';
import { CertificateSourceReader } from '../persistence/certificate-source.reader';

/** Fresh public codes tried before giving up (a collision of 130 random bits is astronomically rare). */
const MAX_CODE_ATTEMPTS = 5;

/**
 * `learning.certificate-issuer` (design D7, §5 worker table, schema doc R6): `CourseCompleted` ->
 * one certificate per (user, course).
 *
 * In the claim transaction:
 * 1. `lockLearningCompletion` (the `lrnc` mutex of (user, course)): serialises the issue with
 *    the certificate revoker, which takes the same lock, so a revoke that raced the issue is
 *    never lost (the revoker sees the certificate, or the issuer sees the REVOKED enrollment).
 * 2. Snapshot the recipient name, live title and instructor name; `issueCertificate`
 *    (`ON CONFLICT DO NOTHING` + the ISSUE transition). `CODE_TAKEN` -> a new code, again.
 * 3. ISSUED: outbox `CertificateIssued`; when the enrollment is already REVOKED (the refund was
 *    processed first), revoke at once (cause ENROLLMENT_REVOKED, so a later regrant reinstates
 *    it) and outbox `CertificateRevoked`.
 *    EXISTS: a redelivery or a re-emitted completion: nothing new, only a missing PDF is rendered.
 *
 * After commit: render the PDF and store it (`CertificatePdfPublisher`). A failure there is
 * logged; the LearningMaintenanceJob re-renders certificates still without a PDF after 10 min.
 * A missing course completion (FK 23503) or learner is non-retryable (DLQ).
 */
@EventHandler(LEARNING_PROGRESS_AGGREGATE, CourseCompleted.type, {
  consumerName: 'learning.certificate-issuer',
})
export class CertificateIssuerHandler implements EventHandlerContract {
  private readonly logger = new Logger(CertificateIssuerHandler.name);

  constructor(
    private readonly sources: CertificateSourceReader,
    private readonly pdf: CertificatePdfPublisher,
  ) {}

  async handle(
    envelope: EventEnvelope,
    trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(CourseCompleted, envelope);
    await lockLearningCompletion(trx, event.userId, event.courseId);
    const source = await this.sources.find(trx, {
      userId: event.userId,
      courseId: event.courseId,
      completedRevisionId: event.revisionId,
    });
    if (source === null) {
      throw new NonRetryableError(
        `CourseCompleted for an unknown learner or course (${event.userId}, ${event.courseId})`,
      );
    }

    const result = await this.issue(trx, envelope.eventId, event, source);
    if (result.outcome === 'EXISTS') {
      if (result.pdfRenderedAt === null) this.renderAfterCommit(context, result.certificateId);
      this.logger.log({ certificateId: result.certificateId }, 'Certificate already issued');
      return;
    }

    const certificateId = result.certificateId;
    const issuedAt = await this.issuedAt(trx, certificateId);
    await publishEvent(trx, CertificateIssued, certificateId, {
      certificateId,
      userId: event.userId,
      courseId: event.courseId,
      actorId: null,
      cause: 'COURSE_COMPLETED',
      issuedAt,
    });
    if (source.enrollmentStatus !== 'ACTIVE') {
      const revoked = await transitionCertificate(trx, {
        certificateId,
        action: 'REVOKE',
        cause: 'ENROLLMENT_REVOKED',
        sourceEventId: envelope.eventId,
      });
      if (revoked.outcome === 'APPLIED') {
        await publishEvent(trx, CertificateRevoked, certificateId, {
          certificateId,
          userId: event.userId,
          courseId: event.courseId,
          actorId: null,
          cause: 'ENROLLMENT_REVOKED',
          revokedAt: revoked.occurredAt.toISOString(),
        });
      }
      this.logger.log(
        { certificateId, enrollmentStatus: source.enrollmentStatus },
        'Certificate issued and revoked at once: the enrollment is not active',
      );
    }
    this.renderAfterCommit(context, certificateId);
  }

  private async issue(
    trx: Transaction<DB>,
    eventId: string,
    event: { userId: string; courseId: string },
    source: {
      recipientName: string;
      courseTitle: string;
      instructorName: string;
      revisionId: string;
    },
  ): Promise<Exclude<IssueCertificateResult, { outcome: 'CODE_TAKEN' }>> {
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
      const result = await issueCertificate(trx, {
        userId: event.userId,
        courseId: event.courseId,
        revisionId: source.revisionId,
        publicCode: newCertificateCode(),
        recipientName: source.recipientName,
        courseTitle: source.courseTitle,
        instructorName: source.instructorName,
        sourceEventId: eventId,
      }).catch((error: unknown) => {
        if (isForeignKeyViolation(error)) {
          throw new NonRetryableError('No course completion for this certificate', {
            cause: error,
          });
        }
        throw error;
      });
      if (result.outcome !== 'CODE_TAKEN') return result;
      this.logger.warn({ attempt }, 'Certificate public code collided; generating a new one');
    }
    throw new Error(`No free certificate code after ${MAX_CODE_ATTEMPTS} attempts`);
  }

  /** The ISSUE timestamp (`issued_at` = the ISSUE transition's now()). */
  private async issuedAt(trx: Transaction<DB>, certificateId: string): Promise<string> {
    const row = await trx
      .selectFrom('learning.certificates')
      .select('issuedAt')
      .where('id', '=', certificateId)
      .executeTakeFirstOrThrow();
    return row.issuedAt.toISOString();
  }

  private renderAfterCommit(context: HandlerContext, certificateId: string): void {
    context.afterCommit(async () => {
      await this.pdf.publish(certificateId);
    });
  }
}

/** pg `23503` (foreign_key_violation): `certificates_user_id_course_id_fk`. */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23503'
  );
}
