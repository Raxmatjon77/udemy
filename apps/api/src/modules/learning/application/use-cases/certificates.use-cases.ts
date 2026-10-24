import { Injectable } from '@nestjs/common';
import {
  type AdminCertificate,
  type AdminUserCertificates,
  type Certificate,
  type CertificatePage,
  CertificateReinstated,
  CertificateRevoked,
  type CertificateVerification,
  type SignedUrl,
} from '@udemy/contracts';
import { IdentityFacade } from '../../../identity';
import {
  CertificateNotFound,
  CertificatePdfPending,
  CertificateTransitionNotAllowed,
  UserNotFound,
} from '../../domain/learning.errors';
import { CertificatePresenter } from '../certificate.presenter';
import { isUuid } from '../learner-access';
import { decodeLearningCursor, pageOf } from '../learning-cursor';
import { CertificateEventPublisher } from '../ports/certificate-event.publisher';
import { CertificatePdfStorage } from '../ports/certificate-pdf.storage';
import { CertificateRepository, type CertificateRecord } from '../ports/certificates.repository';
import { LearningRateLimiter } from '../ports/learning-rate-limiter';
import { TransactionRunner } from '../ports/transaction-runner';

/**
 * The presigned PDF of a certificate, or 409 `certificate_pdf_pending` while the worker has
 * not recorded its rendered PDF yet (it renders after the issue commit; its maintenance job
 * re-renders a missing PDF after 10 min).
 */
async function presignPdf(
  storage: CertificatePdfStorage,
  certificate: CertificateRecord,
): Promise<SignedUrl> {
  if (certificate.pdfObjectKey === null) throw new CertificatePdfPending();
  return storage.presignDownload({
    objectKey: certificate.pdfObjectKey,
    downloadName: `certificate-${certificate.code}.pdf`,
  });
}

/* ------------------------------------------------------------------------- own (student) */

/**
 * `ListMyCertificates` (`GET /me/certificates`, P `certificate:read:own`): ACTIVE and REVOKED,
 * newest first (keyset `(issued_at DESC, id DESC)`).
 */
@Injectable()
export class ListMyCertificatesQuery {
  constructor(
    private readonly certificates: CertificateRepository,
    private readonly presenter: CertificatePresenter,
  ) {}

  async execute(input: {
    readonly userId: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<CertificatePage> {
    const after = input.cursor === undefined ? null : decodeLearningCursor(input.cursor);
    const rows = await this.certificates.listOwnPage({
      userId: input.userId,
      after,
      limit: input.limit + 1,
    });
    const page = pageOf(
      rows,
      input.limit,
      (row) => row.keyset,
      (row) => row.certificate,
    );
    return { items: await this.presenter.views(page.items), nextCursor: page.nextCursor };
  }
}

/** The caller's certificate, or 404 (a foreign id is "not found", IDOR). */
async function ownCertificate(
  certificates: CertificateRepository,
  userId: string,
  certificateId: string,
): Promise<CertificateRecord> {
  const certificate = isUuid(certificateId)
    ? await certificates.findOwn(userId, certificateId)
    : null;
  if (certificate === null) throw new CertificateNotFound();
  return certificate;
}

/** `GetMyCertificate` (`GET /me/certificates/:certificateId`, Pol `certificate:read`). */
@Injectable()
export class GetMyCertificateQuery {
  constructor(
    private readonly certificates: CertificateRepository,
    private readonly presenter: CertificatePresenter,
  ) {}

  async execute(input: {
    readonly userId: string;
    readonly certificateId: string;
  }): Promise<Certificate> {
    return this.presenter.view(
      await ownCertificate(this.certificates, input.userId, input.certificateId),
    );
  }
}

/**
 * `GetMyCertificatePdf` (`GET /me/certificates/:certificateId/pdf`, Pol `certificate:read`):
 * a 15 min presigned GET (attachment), also for a REVOKED certificate (it is the owner's
 * record). 409 `certificate_pdf_pending` until the PDF is rendered.
 */
@Injectable()
export class GetMyCertificatePdfQuery {
  constructor(
    private readonly certificates: CertificateRepository,
    private readonly storage: CertificatePdfStorage,
  ) {}

  async execute(input: {
    readonly userId: string;
    readonly certificateId: string;
  }): Promise<SignedUrl> {
    return presignPdf(
      this.storage,
      await ownCertificate(this.certificates, input.userId, input.certificateId),
    );
  }
}

/* ------------------------------------------------------------------------------ public */

/**
 * `VerifyCertificate` (`GET /certificates/:code`, public, 120/min per end-user IP): the
 * snapshots a certificate states and its status (a REVOKED one says so, with `revokedAt`).
 * The 26-character code (128 random bits) is the only key; there is no listing.
 *
 * Errors: 404 `certificate_not_found`, 429.
 */
@Injectable()
export class VerifyCertificateQuery {
  constructor(
    private readonly rateLimiter: LearningRateLimiter,
    private readonly certificates: CertificateRepository,
    private readonly presenter: CertificatePresenter,
  ) {}

  async execute(input: {
    readonly code: string;
    readonly ip: string;
  }): Promise<CertificateVerification> {
    await this.rateLimiter.hit('certificateVerify', input.ip);
    const certificate = await this.certificates.findByCode(input.code);
    if (certificate === null) throw new CertificateNotFound();
    return this.presenter.verification(certificate);
  }
}

/**
 * `GetPublicCertificatePdf` (`GET /certificates/:code/pdf`, public): ACTIVE certificates only
 * (a REVOKED one is 404 here), 409 while the PDF is being rendered. Shares the verification
 * rate limit.
 */
@Injectable()
export class GetPublicCertificatePdfQuery {
  constructor(
    private readonly rateLimiter: LearningRateLimiter,
    private readonly certificates: CertificateRepository,
    private readonly storage: CertificatePdfStorage,
  ) {}

  async execute(input: { readonly code: string; readonly ip: string }): Promise<SignedUrl> {
    await this.rateLimiter.hit('certificateVerify', input.ip);
    const certificate = await this.certificates.findByCode(input.code);
    if (certificate === null || certificate.status !== 'ACTIVE') throw new CertificateNotFound();
    return presignPdf(this.storage, certificate);
  }
}

/* ------------------------------------------------------------------------------- admin */

/**
 * `AdminListUserCertificates` (`GET /admin/users/:userId/certificates`, P
 * `certificate:manage:any`): every certificate of the user with its transition log.
 *
 * Errors: 404 `user_not_found`.
 */
@Injectable()
export class AdminListUserCertificatesQuery {
  constructor(
    private readonly identity: IdentityFacade,
    private readonly certificates: CertificateRepository,
    private readonly presenter: CertificatePresenter,
  ) {}

  async execute(userId: string): Promise<AdminUserCertificates> {
    if (!isUuid(userId) || (await this.identity.getUserSummary(userId)) === null) {
      throw new UserNotFound();
    }
    const rows = await this.certificates.listByUser(userId);
    return { items: await this.presenter.adminViews(rows) };
  }
}

export interface AdminCertificateActionInput {
  readonly actorId: string;
  readonly certificateId: string;
  readonly action: 'REVOKE' | 'REINSTATE';
  /** 10–2000 characters (the request schema and `certificate_transitions_reason_ck`). */
  readonly reason: string;
}

/**
 * `AdminRevokeCertificate` / `AdminReinstateCertificate` (design §5, D7;
 * `POST /admin/certificates/:certificateId/{revoke|reinstate}`): a transition with cause ADMIN,
 * the actor and the reason, plus outbox `CertificateRevoked` / `CertificateReinstated` (key =
 * certificateId) in the same transaction.
 *
 * - Lock order as the worker issuer/revoker (§14): the `lrnc` (user, course) mutex first, then
 *   the certificate row (`transitionCertificate`), so an admin action and an enrollment
 *   revoke/regrant of the same certificate are serialised.
 * - `revoked_at` is set by SQL `now()` inside `@udemy/db` (never a JS Date).
 * - Admin revocations stick: the worker's regrant reinstates only an enrollment-caused revoke
 *   (`transitionCertificate` R13 pre-check, `certificate_transitions_reinstate_cause_ck`).
 *
 * Errors: 404 `certificate_not_found`, 409 `invalid_state_transition` (already in that state).
 */
@Injectable()
export class AdminCertificateActionCommand {
  constructor(
    private readonly certificates: CertificateRepository,
    private readonly events: CertificateEventPublisher,
    private readonly presenter: CertificatePresenter,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: AdminCertificateActionInput): Promise<AdminCertificate> {
    const current = isUuid(input.certificateId)
      ? await this.certificates.findById(input.certificateId)
      : null;
    if (current === null) throw new CertificateNotFound();

    const updated = await this.tx.run(async (trx) => {
      await this.certificates.lockCompletion(trx, current.userId, current.courseId);
      const result = await this.certificates.transitionAsAdmin(trx, {
        certificateId: current.id,
        action: input.action,
        actorId: input.actorId,
        reason: input.reason,
      });
      if (result.outcome === 'NOT_FOUND') throw new CertificateNotFound();
      if (result.outcome === 'NOOP') throw new CertificateTransitionNotAllowed();
      const base = {
        certificateId: current.id,
        userId: current.userId,
        courseId: current.courseId,
        cause: 'ADMIN' as const,
        actorId: input.actorId,
      };
      if (input.action === 'REVOKE') {
        await this.events.publish(trx, CertificateRevoked, {
          ...base,
          revokedAt: result.occurredAt.toISOString(),
        });
      } else {
        await this.events.publish(trx, CertificateReinstated, {
          ...base,
          reinstatedAt: result.occurredAt.toISOString(),
        });
      }
      const after = await this.certificates.findById(current.id, trx);
      if (after === null) throw new CertificateNotFound();
      return after;
    });
    const [view] = await this.presenter.adminViews([updated]);
    if (view === undefined) throw new Error('adminViews returned nothing for one certificate');
    return view;
  }
}
