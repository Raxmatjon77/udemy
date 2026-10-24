import type { TimestampKeyset } from '../learning-cursor';
import type {
  CertificateStatus,
  CertificateTransitionAction,
  CertificateTransitionCause,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';

export interface CertificateRecord {
  readonly id: string;
  readonly code: string;
  readonly userId: string;
  readonly courseId: string;
  readonly recipientName: string;
  readonly courseTitle: string;
  readonly instructorName: string;
  readonly status: CertificateStatus;
  readonly issuedAt: Date;
  readonly revokedAt: Date | null;
  /** Set once the worker rendered the PDF (`certificates/{id}/v1.pdf`). */
  readonly pdfObjectKey: string | null;
}

/** Keyset of `issued_at` (exact SQL text, P2 §14) and the id. */
export type CertificateKeyset = TimestampKeyset;

export interface CertificatePageRow {
  readonly certificate: CertificateRecord;
  readonly keyset: CertificateKeyset;
}

export interface CertificateTransitionRecord {
  readonly certificateId: string;
  readonly seq: number;
  readonly action: CertificateTransitionAction;
  readonly cause: CertificateTransitionCause;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export type AdminCertificateTransitionResult =
  | { readonly outcome: 'APPLIED'; readonly occurredAt: Date }
  | { readonly outcome: 'NOOP' }
  | { readonly outcome: 'NOT_FOUND' };

/**
 * `learning.certificates` / `certificate_transitions`. Certificates are ISSUED by the worker
 * (P5-T15); the api reads them and applies ADMIN revoke/reinstate through the `@udemy/db`
 * `transitionCertificate` (certificate row lock, `max(seq) + 1`, `revoked_at = now()` in SQL).
 */
export abstract class CertificateRepository {
  abstract listOwnPage(
    input: {
      readonly userId: string;
      readonly after: CertificateKeyset | null;
      readonly limit: number;
    },
    ex?: Executor,
  ): Promise<CertificatePageRow[]>;

  abstract findOwn(
    userId: string,
    certificateId: string,
    ex?: Executor,
  ): Promise<CertificateRecord | null>;

  abstract findById(certificateId: string, ex?: Executor): Promise<CertificateRecord | null>;

  abstract findByCode(code: string, ex?: Executor): Promise<CertificateRecord | null>;

  /** Every certificate of the user, newest first (admin user detail). */
  abstract listByUser(userId: string, ex?: Executor): Promise<CertificateRecord[]>;

  /** Transitions of these certificates, oldest first per certificate. */
  abstract listTransitions(
    certificateIds: readonly string[],
    ex?: Executor,
  ): Promise<CertificateTransitionRecord[]>;

  /** The `lrnc` (user, course) mutex: the worker issuer/revoker take it first too (§14). */
  abstract lockCompletion(trx: Transaction<DB>, userId: string, courseId: string): Promise<void>;

  /** ADMIN revoke/reinstate (cause ADMIN, actor and reason recorded; admin revocations stick). */
  abstract transitionAsAdmin(
    trx: Transaction<DB>,
    input: {
      readonly certificateId: string;
      readonly action: 'REVOKE' | 'REINSTATE';
      readonly actorId: string;
      readonly reason: string;
    },
  ): Promise<AdminCertificateTransitionResult>;

  /** `certificates.user_id`, or null (ownership resolver). */
  abstract ownerOf(certificateId: string): Promise<string | null>;
}
