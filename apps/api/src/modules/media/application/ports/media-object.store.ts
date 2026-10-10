import type { ListedPart, PartPlan } from '@udemy/storage';

export interface SignedObjectUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * The S3 operations media needs, with bucket roles fixed (design D11):
 * sources live in the quarantine `uploads` bucket and are never presigned for GET; only
 * `media` objects are served. Implemented over `@udemy/storage`'s `ObjectStorage`; every
 * failure is a typed storage error (`StorageUnavailableError` -> 503).
 */
export abstract class MediaObjectStore {
  /** CreateMultipartUpload with the allowlisted type and `Content-Disposition: attachment`. */
  abstract createSourceUpload(sourceKey: string, contentType: string): Promise<string>;
  /** Presigned UploadPart PUT with `content-length` signed. */
  abstract presignSourcePart(input: {
    readonly sourceKey: string;
    readonly uploadId: string;
    readonly partNumber: number;
    readonly contentLength: number;
    readonly ttlSeconds: number;
  }): Promise<SignedObjectUrl>;
  /** Server-side ListParts; `null` when S3 no longer knows the upload (NoSuchUpload). */
  abstract listSourceParts(sourceKey: string, uploadId: string): Promise<ListedPart[] | null>;
  /** CompleteMultipartUpload from listed parts; `false` when S3 answers NoSuchUpload. */
  abstract completeSourceUpload(input: {
    readonly sourceKey: string;
    readonly uploadId: string;
    readonly parts: readonly ListedPart[];
    readonly plan: PartPlan;
  }): Promise<boolean>;
  /** Idempotent abort. */
  abstract abortSourceUpload(sourceKey: string, uploadId: string): Promise<void>;
  /** The completed source's size, or null when there is no object. */
  abstract sourceSize(sourceKey: string): Promise<number | null>;
  abstract deleteSource(sourceKey: string): Promise<void>;
  /** A small text object (variant playlist) from the media bucket. */
  abstract readMediaText(key: string): Promise<string>;
  /** Presigned GET on the media bucket. */
  abstract presignMediaGet(
    key: string,
    options: {
      readonly ttlSeconds: number;
      readonly responseContentType?: string;
      readonly responseContentDisposition?: string;
    },
  ): Promise<SignedObjectUrl>;
}
