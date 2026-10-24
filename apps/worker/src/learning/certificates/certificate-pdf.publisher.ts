import { Injectable, Logger } from '@nestjs/common';
import { certificatePdfObjectKey, recordCertificatePdf } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { ObjectStorage } from '@udemy/storage';
import { WorkerConfigService } from '../../shared/config';
import { renderCertificatePdf } from './certificate-pdf';

export type CertificatePdfOutcome = 'RENDERED' | 'ALREADY_RENDERED' | 'NOT_FOUND';

/**
 * Renders a certificate's PDF and stores it (design D7, schema doc R6):
 *
 * 1. read the certificate snapshot (outside any claim transaction);
 * 2. render (deterministic bytes) and PUT it to the media bucket at the ONLY key
 *    `certificates_pdf_ck` accepts, `certificates/{id}/v1.pdf`, so a retry overwrites instead of
 *    duplicating;
 * 3. `recordCertificatePdf` (`pdf_object_key`, `pdf_rendered_at = now()`, once).
 *
 * Called after the issuer's transaction committed (`afterCommit`) and by the
 * LearningMaintenanceJob for certificates still without a PDF 10 minutes after issue. The api
 * serves the PDF only through presigned GETs (409 `certificate_pdf_pending` until step 3).
 */
@Injectable()
export class CertificatePdfPublisher {
  private readonly logger = new Logger(CertificatePdfPublisher.name);

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly config: WorkerConfigService,
  ) {}

  /** The public verification page of a code (also the QR target). */
  verifyUrl(code: string): string {
    return `${this.config.get('STUDENT_APP_ORIGIN')}/certificates/${encodeURIComponent(code)}`;
  }

  async publish(certificateId: string): Promise<CertificatePdfOutcome> {
    const row = await this.db
      .selectFrom('learning.certificates')
      .select([
        'id',
        'publicCode',
        'recipientName',
        'courseTitle',
        'instructorName',
        'issuedAt',
        'pdfRenderedAt',
      ])
      .where('id', '=', certificateId)
      .executeTakeFirst();
    if (row === undefined) return 'NOT_FOUND';
    if (row.pdfRenderedAt !== null) return 'ALREADY_RENDERED';

    const pdf = await renderCertificatePdf({
      code: row.publicCode,
      recipientName: row.recipientName,
      courseTitle: row.courseTitle,
      instructorName: row.instructorName,
      issuedAt: row.issuedAt,
      verifyUrl: this.verifyUrl(row.publicCode),
    });
    await this.storage.putObject({
      bucket: 'media',
      key: certificatePdfObjectKey(row.id),
      body: pdf,
      contentType: 'application/pdf',
      cacheControl: 'private, max-age=0, no-cache',
    });
    const recorded = await recordCertificatePdf(this.db, row.id);
    this.logger.log(
      { certificateId: row.id, bytes: pdf.length, recorded },
      'Certificate PDF stored',
    );
    return recorded ? 'RENDERED' : 'ALREADY_RENDERED';
  }
}
