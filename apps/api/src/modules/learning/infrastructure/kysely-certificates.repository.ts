import { Injectable } from '@nestjs/common';
import type {
  CertificateStatus,
  CertificateTransitionAction,
  CertificateTransitionCause,
} from '@udemy/contracts';
import {
  type DB,
  type Executor,
  lockLearningCompletion,
  sql,
  type Transaction,
  transitionCertificate,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type AdminCertificateTransitionResult,
  type CertificateKeyset,
  type CertificatePageRow,
  type CertificateRecord,
  CertificateRepository,
  type CertificateTransitionRecord,
} from '../application/ports/certificates.repository';
import { exactUtcText } from './row-mapping';

const CERTIFICATE_COLUMNS = [
  'id',
  'publicCode',
  'userId',
  'courseId',
  'recipientName',
  'courseTitle',
  'instructorName',
  'status',
  'issuedAt',
  'revokedAt',
  'pdfObjectKey',
] as const;

interface CertificateRow {
  id: string;
  publicCode: string;
  userId: string;
  courseId: string;
  recipientName: string;
  courseTitle: string;
  instructorName: string;
  status: string;
  issuedAt: Date;
  revokedAt: Date | null;
  pdfObjectKey: string | null;
}

function toRecord(row: CertificateRow): CertificateRecord {
  return {
    id: row.id,
    code: row.publicCode,
    userId: row.userId,
    courseId: row.courseId,
    recipientName: row.recipientName,
    courseTitle: row.courseTitle,
    instructorName: row.instructorName,
    status: row.status as CertificateStatus,
    issuedAt: row.issuedAt,
    revokedAt: row.revokedAt,
    pdfObjectKey: row.pdfObjectKey,
  };
}

/**
 * `learning.certificates` / `certificate_transitions` (schema doc §1, R6, R13). Reads use the
 * query builder; the ADMIN transition goes through `@udemy/db` `transitionCertificate` (row lock,
 * `max(seq) + 1`, status and `revoked_at = now()` in SQL in the same transaction, checked at
 * COMMIT by `certificates_status_log_ck`).
 */
@Injectable()
export class KyselyCertificateRepository extends CertificateRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async listOwnPage(
    input: {
      readonly userId: string;
      readonly after: CertificateKeyset | null;
      readonly limit: number;
    },
    ex: Executor = this.db,
  ): Promise<CertificatePageRow[]> {
    let query = ex
      .selectFrom('learning.certificates')
      .select(CERTIFICATE_COLUMNS)
      .select(exactUtcText('issued_at').as('issuedAtKey'))
      .where('userId', '=', input.userId);
    if (input.after !== null) {
      query = query.where(
        sql<boolean>`(issued_at, id) < (${input.after.at}::timestamptz, ${input.after.id}::uuid)`,
      );
    }
    const rows = await query
      .orderBy('issuedAt', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit)
      .execute();
    return rows.map(({ issuedAtKey, ...row }) => ({
      certificate: toRecord(row),
      keyset: { at: issuedAtKey, id: row.id },
    }));
  }

  async findOwn(
    userId: string,
    certificateId: string,
    ex: Executor = this.db,
  ): Promise<CertificateRecord | null> {
    const row = await ex
      .selectFrom('learning.certificates')
      .select(CERTIFICATE_COLUMNS)
      .where('id', '=', certificateId)
      .where('userId', '=', userId)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async findById(certificateId: string, ex: Executor = this.db): Promise<CertificateRecord | null> {
    const row = await ex
      .selectFrom('learning.certificates')
      .select(CERTIFICATE_COLUMNS)
      .where('id', '=', certificateId)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async findByCode(code: string, ex: Executor = this.db): Promise<CertificateRecord | null> {
    const row = await ex
      .selectFrom('learning.certificates')
      .select(CERTIFICATE_COLUMNS)
      .where('publicCode', '=', code)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async listByUser(userId: string, ex: Executor = this.db): Promise<CertificateRecord[]> {
    const rows = await ex
      .selectFrom('learning.certificates')
      .select(CERTIFICATE_COLUMNS)
      .where('userId', '=', userId)
      .orderBy('issuedAt', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toRecord);
  }

  async listTransitions(
    certificateIds: readonly string[],
    ex: Executor = this.db,
  ): Promise<CertificateTransitionRecord[]> {
    if (certificateIds.length === 0) return [];
    const rows = await ex
      .selectFrom('learning.certificateTransitions')
      .select(['certificateId', 'seq', 'action', 'cause', 'actorId', 'reason', 'occurredAt'])
      .where('certificateId', 'in', [...new Set(certificateIds)])
      .orderBy('certificateId')
      .orderBy('seq')
      .execute();
    return rows.map((row) => ({
      ...row,
      action: row.action as CertificateTransitionAction,
      cause: row.cause as CertificateTransitionCause,
    }));
  }

  lockCompletion(trx: Transaction<DB>, userId: string, courseId: string): Promise<void> {
    return lockLearningCompletion(trx, userId, courseId);
  }

  async transitionAsAdmin(
    trx: Transaction<DB>,
    input: {
      readonly certificateId: string;
      readonly action: 'REVOKE' | 'REINSTATE';
      readonly actorId: string;
      readonly reason: string;
    },
  ): Promise<AdminCertificateTransitionResult> {
    const result = await transitionCertificate(trx, {
      certificateId: input.certificateId,
      action: input.action,
      cause: 'ADMIN',
      actorId: input.actorId,
      reason: input.reason,
    });
    switch (result.outcome) {
      case 'APPLIED':
        return { outcome: 'APPLIED', occurredAt: result.occurredAt };
      case 'NOT_FOUND':
        return { outcome: 'NOT_FOUND' };
      // SKIPPED_ADMIN_REVOKE is a regrant outcome; an ADMIN cause never gets it.
      default:
        return { outcome: 'NOOP' };
    }
  }

  async ownerOf(certificateId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('learning.certificates')
      .select('userId')
      .where('id', '=', certificateId)
      .executeTakeFirst();
    return row?.userId ?? null;
  }
}
