import { Inject, Injectable } from '@nestjs/common';
import type { SignedUrl } from '@udemy/contracts';
import { attachmentContentDisposition, ObjectStorage } from '@udemy/storage';
import { CertificatePdfStorage } from '../application/ports/certificate-pdf.storage';

/** 15 min (design §5 `GetMyCertificatePdf`). */
export const CERTIFICATE_PDF_URL_TTL_SECONDS = 15 * 60;

/**
 * Presigned GETs of rendered certificate PDFs on the MEDIA bucket (where the worker PUTs
 * `certificates/{id}/v1.pdf`), served as an attachment with `application/pdf`. Uses the
 * process-wide `ObjectStorage` of `ObjectStorageModule` (global); signing is local, and a
 * storage failure surfaces as the shared 503 mapping.
 */
@Injectable()
export class S3CertificatePdfStorage extends CertificatePdfStorage {
  constructor(@Inject(ObjectStorage) private readonly storage: ObjectStorage) {
    super();
  }

  async presignDownload(input: {
    readonly objectKey: string;
    readonly downloadName: string;
  }): Promise<SignedUrl> {
    const signed = await this.storage.presignGet({
      bucket: 'media',
      key: input.objectKey,
      ttlSeconds: CERTIFICATE_PDF_URL_TTL_SECONDS,
      responseContentType: 'application/pdf',
      responseContentDisposition: attachmentContentDisposition(input.downloadName),
    });
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  }
}
