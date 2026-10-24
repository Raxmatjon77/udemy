import type { SignedUrl } from '@udemy/contracts';

/**
 * Presigned downloads of rendered certificate PDFs (design §5: attachment, 15 min). The worker
 * PUTs them to the media bucket at `certificates/{id}/v1.pdf` (D7); the api only signs GETs.
 * Signing is local (no S3 round trip); an unusable storage configuration is a 503.
 */
export abstract class CertificatePdfStorage {
  abstract presignDownload(input: {
    readonly objectKey: string;
    readonly downloadName: string;
  }): Promise<SignedUrl>;
}
