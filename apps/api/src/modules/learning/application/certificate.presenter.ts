import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  AdminCertificate,
  Certificate,
  CertificateTransition,
  CertificateVerification,
} from '@udemy/contracts';
import { CatalogFacade, COURSE_SUMMARIES_MAX_IDS, type CourseSummary } from '../../catalog';
import { IdentityFacade } from '../../identity';
import {
  CertificateRepository,
  type CertificateRecord,
  type CertificateTransitionRecord,
} from './ports/certificates.repository';

/** A rendered PDF exists (`pdf_rendered_at`, set by the worker after the issue commit). */
export function isPdfReady(certificate: CertificateRecord): boolean {
  return certificate.pdfObjectKey !== null;
}

/** The learner's (and the admin's) view of a certificate. */
export function toCertificateView(
  certificate: CertificateRecord,
  courseSlug: string | null,
): Certificate {
  return {
    id: certificate.id,
    code: certificate.code,
    courseId: certificate.courseId,
    courseSlug,
    courseTitle: certificate.courseTitle,
    recipientName: certificate.recipientName,
    instructorName: certificate.instructorName,
    status: certificate.status,
    issuedAt: certificate.issuedAt.toISOString(),
    revokedAt: certificate.revokedAt?.toISOString() ?? null,
    pdfReady: isPdfReady(certificate),
  };
}

/** Public verification: the snapshots, the status, and the PDF only when ACTIVE and rendered. */
export function toVerificationView(
  certificate: CertificateRecord,
  publicCourseSlug: string | null,
): CertificateVerification {
  return {
    code: certificate.code,
    status: certificate.status,
    recipientName: certificate.recipientName,
    courseTitle: certificate.courseTitle,
    instructorName: certificate.instructorName,
    issuedAt: certificate.issuedAt.toISOString(),
    revokedAt: certificate.revokedAt?.toISOString() ?? null,
    courseSlug: publicCourseSlug,
    pdfAvailable: certificate.status === 'ACTIVE' && isPdfReady(certificate),
  };
}

/**
 * A stable id for a transition row. `certificate_transitions` is keyed by
 * `(certificate_id, seq)` and has no id column; the contract wants a uuid (a list key in the
 * admin UI), so it is derived deterministically: SHA-256 of `certificateId:seq`, formatted as
 * an RFC 9562 version-8 (custom) uuid. Same row, same id, on every read.
 */
export function certificateTransitionId(certificateId: string, seq: number): string {
  const bytes = createHash('sha256')
    .update(`${certificateId.toLowerCase()}:${seq}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Course slugs and admin views of certificates: `CatalogFacade.getCourseSummaries` (live slug,
 * PUBLISHED or ARCHIVED) in batches, and `IdentityFacade` for admin actor names (admins see
 * banned actors too).
 */
@Injectable()
export class CertificatePresenter {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly identity: IdentityFacade,
    private readonly certificates: CertificateRepository,
  ) {}

  /** courseId -> live course summary (absent when the course no longer exists). */
  async courses(courseIds: readonly string[]): Promise<ReadonlyMap<string, CourseSummary>> {
    const ids = [...new Set(courseIds)];
    const result = new Map<string, CourseSummary>();
    for (let i = 0; i < ids.length; i += COURSE_SUMMARIES_MAX_IDS) {
      for (const summary of await this.catalog.getCourseSummaries(
        ids.slice(i, i + COURSE_SUMMARIES_MAX_IDS),
      )) {
        result.set(summary.id, summary);
      }
    }
    return result;
  }

  async views(certificates: readonly CertificateRecord[]): Promise<Certificate[]> {
    const courses = await this.courses(certificates.map((c) => c.courseId));
    return certificates.map((c) => toCertificateView(c, courses.get(c.courseId)?.slug ?? null));
  }

  async view(certificate: CertificateRecord): Promise<Certificate> {
    const [view] = await this.views([certificate]);
    if (view === undefined) throw new Error('views returned nothing for one certificate');
    return view;
  }

  /** Verification: the slug only while the course is publicly listed (PUBLISHED). */
  async verification(certificate: CertificateRecord): Promise<CertificateVerification> {
    const course = (await this.courses([certificate.courseId])).get(certificate.courseId);
    return toVerificationView(
      certificate,
      course !== undefined && course.status === 'PUBLISHED' ? course.slug : null,
    );
  }

  /** Admin views with the full transition log (oldest first) and the actors' names. */
  async adminViews(certificates: readonly CertificateRecord[]): Promise<AdminCertificate[]> {
    if (certificates.length === 0) return [];
    const transitions = await this.certificates.listTransitions(certificates.map((c) => c.id));
    const actorIds = [
      ...new Set(transitions.flatMap((t) => (t.actorId === null ? [] : [t.actorId]))),
    ];
    const actors = new Map(
      (await this.identity.getUserSummaries(actorIds)).map((u) => [u.id, u.displayName]),
    );
    const byCertificate = new Map<string, CertificateTransitionRecord[]>();
    for (const t of transitions) {
      const list = byCertificate.get(t.certificateId) ?? [];
      list.push(t);
      byCertificate.set(t.certificateId, list);
    }
    const views = await this.views(certificates);
    return certificates.map((certificate, index) => ({
      certificate: views[index]!,
      userId: certificate.userId,
      transitions: (byCertificate.get(certificate.id) ?? [])
        .sort((a, b) => a.seq - b.seq)
        .map((t): CertificateTransition => {
          const actorName = t.actorId === null ? undefined : actors.get(t.actorId);
          return {
            id: certificateTransitionId(t.certificateId, t.seq),
            action: t.action,
            cause: t.cause,
            actorId: t.actorId,
            actor:
              t.actorId === null || actorName === undefined
                ? null
                : { id: t.actorId, displayName: actorName },
            reason: t.reason,
            occurredAt: t.occurredAt.toISOString(),
          };
        }),
    }));
  }
}
