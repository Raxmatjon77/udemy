/**
 * Certificate issue and transitions (docs/phase-5-schema-design.md §1 section 8, R6, R13).
 * Worker-owned by convention (api and worker share udemy_app).
 *
 * - certificates.status / issued_at / revoked_at materialise certificate_transitions; both are
 *   written in one transaction and checked at COMMIT (certificates_status_log_ck).
 * - Transitions append `max(seq) + 1` under the certificate row lock (P4 seq-chain pattern); the
 *   chain FK makes `from_status` equal the predecessor's `to_status`.
 * - A regrant only reinstates an enrollment-caused revoke (admin revocations stick, open point 4):
 *   pre-checked here (SKIPPED_ADMIN_REVOKE), with certificate_transitions_reinstate_cause_ck as
 *   the COMMIT backstop.
 */
import { sql } from 'kysely';
import { assertNonEmptyText, assertOneOf } from '../internal/assert';
import { type Executor, requireTransaction } from '../transaction';

/** 26 Crockford base32 characters (`certificates_public_code_ck`, contracts CERTIFICATE_CODE_PATTERN). */
export const CERTIFICATE_PUBLIC_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The only key `certificates_pdf_ck` accepts. */
export function certificatePdfObjectKey(certificateId: string): string {
  return `certificates/${certificateId.toLowerCase()}/v1.pdf`;
}

export interface IssueCertificateInput {
  userId: string;
  courseId: string;
  /** Live revision at issue (title source). */
  revisionId: string;
  publicCode: string;
  recipientName: string;
  courseTitle: string;
  instructorName: string;
  /** The CourseCompleted event id. */
  sourceEventId: string;
}

export type IssueCertificateResult =
  /** Inserted with its ISSUE transition (-> CertificateIssued after commit, render the PDF). */
  | { outcome: 'ISSUED'; certificateId: string }
  /** Already issued for (user, course) or this event: re-render only if `pdfRenderedAt` is null. */
  | { outcome: 'EXISTS'; certificateId: string; pdfRenderedAt: Date | null }
  /** `publicCode` collided with another certificate: generate a new code and call again. */
  | { outcome: 'CODE_TAKEN' };

/**
 * R6: `INSERT ... ON CONFLICT DO NOTHING` (no target: covers (user, course), the source event and
 * the public code), then the ISSUE transition in the same transaction. The completion must exist
 * (certificates_user_id_course_id_fk, 23503 -> non-retryable).
 */
export async function issueCertificate(
  executor: Executor,
  input: IssueCertificateInput,
): Promise<IssueCertificateResult> {
  if (!CERTIFICATE_PUBLIC_CODE_PATTERN.test(input.publicCode)) {
    throw new RangeError('publicCode must be 26 Crockford base32 characters');
  }
  assertNonEmptyText('recipientName', input.recipientName, 80);
  assertNonEmptyText('courseTitle', input.courseTitle, 60);
  assertNonEmptyText('instructorName', input.instructorName, 80);
  const trx = requireTransaction(executor, 'issueCertificate');
  const { rows } = await sql<{ id: string }>`
    INSERT INTO learning.certificates (public_code, user_id, course_id, revision_id, recipient_name, course_title,
                                       instructor_name, source_event_id)
    VALUES (${input.publicCode}, ${input.userId}, ${input.courseId}, ${input.revisionId}, ${input.recipientName},
            ${input.courseTitle}, ${input.instructorName}, ${input.sourceEventId})
    ON CONFLICT DO NOTHING
    RETURNING id
  `.execute(trx);
  const inserted = rows[0];
  if (inserted !== undefined) {
    await sql`
      INSERT INTO learning.certificate_transitions (certificate_id, seq, action, from_status, to_status, cause, source_event_id)
      VALUES (${inserted.id}, 1, 'ISSUE', NULL, 'ACTIVE', 'COURSE_COMPLETED', ${input.sourceEventId})
    `.execute(trx);
    return { outcome: 'ISSUED', certificateId: inserted.id };
  }
  const existing = await sql<{ id: string; pdfRenderedAt: Date | null }>`
    SELECT id, pdf_rendered_at FROM learning.certificates
     WHERE (user_id = ${input.userId} AND course_id = ${input.courseId}) OR source_event_id = ${input.sourceEventId}
     ORDER BY (user_id = ${input.userId} AND course_id = ${input.courseId}) DESC
     LIMIT 1
  `.execute(trx);
  const row = existing.rows[0];
  if (row === undefined) return { outcome: 'CODE_TAKEN' };
  return { outcome: 'EXISTS', certificateId: row.id, pdfRenderedAt: row.pdfRenderedAt };
}

/** Records the rendered PDF once (deterministic key). false = already recorded or no such certificate. */
export async function recordCertificatePdf(
  executor: Executor,
  certificateId: string,
): Promise<boolean> {
  const result = await sql`
    UPDATE learning.certificates
       SET pdf_object_key = 'certificates/' || id::text || '/v1.pdf', pdf_rendered_at = now()
     WHERE id = ${certificateId} AND pdf_rendered_at IS NULL
  `.execute(executor);
  return Number(result.numAffectedRows ?? 0n) === 1;
}

export type CertificateTransitionInput =
  | {
      certificateId: string;
      action: 'REVOKE';
      cause: 'ENROLLMENT_REVOKED';
      sourceEventId: string;
    }
  | {
      certificateId: string;
      action: 'REINSTATE';
      cause: 'ENROLLMENT_REGRANTED';
      sourceEventId: string;
    }
  | {
      certificateId: string;
      action: 'REVOKE' | 'REINSTATE';
      cause: 'ADMIN';
      actorId: string;
      /** 10..2000 characters (certificate_transitions_reason_ck). */
      reason: string;
    };

export type CertificateTransitionResult =
  | { outcome: 'APPLIED'; seq: number; status: 'ACTIVE' | 'REVOKED'; occurredAt: Date }
  /** Already in the target status: nothing written (idempotent replays). */
  | { outcome: 'NOOP'; status: 'ACTIVE' | 'REVOKED' }
  /** R13: a regrant met a revoke that was not enrollment-caused (an admin revoke sticks). */
  | { outcome: 'SKIPPED_ADMIN_REVOKE'; status: 'REVOKED' }
  | { outcome: 'NOT_FOUND' };

/** REVOKE / REINSTATE under the certificate row lock, with `max(seq) + 1`. */
export async function transitionCertificate(
  executor: Executor,
  input: CertificateTransitionInput,
): Promise<CertificateTransitionResult> {
  assertOneOf('action', input.action, ['REVOKE', 'REINSTATE'] as const);
  if (input.cause === 'ADMIN') {
    if (
      typeof input.reason !== 'string' ||
      input.reason.length < 10 ||
      input.reason.length > 2000
    ) {
      throw new RangeError('an admin certificate action needs a reason of 10..2000 characters');
    }
  } else if (
    (input.action === 'REVOKE') !== (input.cause === 'ENROLLMENT_REVOKED') ||
    (input.action === 'REINSTATE') !== (input.cause === 'ENROLLMENT_REGRANTED')
  ) {
    throw new RangeError(`cause ${input.cause} does not fit action ${input.action}`);
  }
  const trx = requireTransaction(executor, 'transitionCertificate');
  const { rows } = await sql<{ status: 'ACTIVE' | 'REVOKED' }>`
    SELECT status FROM learning.certificates WHERE id = ${input.certificateId} FOR UPDATE
  `.execute(trx);
  const current = rows[0];
  if (current === undefined) return { outcome: 'NOT_FOUND' };
  const target = input.action === 'REVOKE' ? 'REVOKED' : 'ACTIVE';
  if (current.status === target) return { outcome: 'NOOP', status: current.status };

  const head = await sql<{ seq: number; cause: string }>`
    SELECT seq, cause FROM learning.certificate_transitions
     WHERE certificate_id = ${input.certificateId} ORDER BY seq DESC LIMIT 1
  `.execute(trx);
  const prev = head.rows[0]!;
  if (input.cause === 'ENROLLMENT_REGRANTED' && prev.cause !== 'ENROLLMENT_REVOKED') {
    return { outcome: 'SKIPPED_ADMIN_REVOKE', status: 'REVOKED' };
  }
  const isAdmin = input.cause === 'ADMIN';
  const inserted = await sql<{ seq: number; occurredAt: Date }>`
    INSERT INTO learning.certificate_transitions
           (certificate_id, seq, action, from_status, to_status, cause, actor_id, reason, source_event_id)
    VALUES (${input.certificateId}, ${prev.seq + 1}, ${input.action}, ${current.status}, ${target}, ${input.cause},
            ${isAdmin ? input.actorId : null}, ${isAdmin ? input.reason : null},
            ${isAdmin ? null : input.sourceEventId})
    RETURNING seq, occurred_at
  `.execute(trx);
  const t = inserted.rows[0]!;
  // revoked_at = now() = the transition's defaulted occurred_at (same transaction). Never round-trip
  // it through a JS Date: that drops the microseconds and fails certificates_status_log_ck.
  await sql`
    UPDATE learning.certificates
       SET status = ${target}, revoked_at = ${target === 'REVOKED' ? sql`now()` : sql`NULL`}
     WHERE id = ${input.certificateId}
  `.execute(trx);
  return { outcome: 'APPLIED', seq: t.seq, status: target, occurredAt: t.occurredAt };
}

/** The certificate of (user, course), for the enrollment-revoked / regranted handlers. */
export async function findCertificateId(
  executor: Executor,
  userId: string,
  courseId: string,
): Promise<string | null> {
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM learning.certificates WHERE user_id = ${userId} AND course_id = ${courseId}
  `.execute(executor);
  return rows[0]?.id ?? null;
}
