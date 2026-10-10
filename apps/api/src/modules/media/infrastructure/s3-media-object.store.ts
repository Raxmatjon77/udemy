import { Inject, Injectable } from '@nestjs/common';
import { type ListedPart, ObjectStorage, type PartPlan } from '@udemy/storage';
import { MediaObjectStore, type SignedObjectUrl } from '../application/ports/media-object.store';
import { isNoSuchUpload, toMediaStorageError } from './storage-errors';

/**
 * `MediaObjectStore` over the shared `ObjectStorage` (provided by `ObjectStorageModule`).
 * Sources always go to the `uploads` (quarantine) role; reads and presigned GETs only to
 * `media` (D11; `presignGet` refuses any other role at runtime too).
 */
@Injectable()
export class S3MediaObjectStore extends MediaObjectStore {
  constructor(@Inject(ObjectStorage) private readonly storage: ObjectStorage) {
    super();
  }

  async createSourceUpload(sourceKey: string, contentType: string): Promise<string> {
    const { uploadId } = await this.call(() =>
      this.storage.createMultipartUpload({
        bucket: 'uploads',
        key: sourceKey,
        contentType,
        // Raw user bytes are never served inline (D11, §9).
        contentDisposition: 'attachment',
      }),
    );
    return uploadId;
  }

  presignSourcePart(input: {
    sourceKey: string;
    uploadId: string;
    partNumber: number;
    contentLength: number;
    ttlSeconds: number;
  }): Promise<SignedObjectUrl> {
    return this.call(() =>
      this.storage.presignUploadPart({
        bucket: 'uploads',
        key: input.sourceKey,
        uploadId: input.uploadId,
        partNumber: input.partNumber,
        contentLength: input.contentLength,
        ttlSeconds: input.ttlSeconds,
      }),
    );
  }

  async listSourceParts(sourceKey: string, uploadId: string): Promise<ListedPart[] | null> {
    try {
      return await this.storage.listParts({ bucket: 'uploads', key: sourceKey, uploadId });
    } catch (error) {
      if (isNoSuchUpload(error)) return null;
      throw toMediaStorageError(error);
    }
  }

  async completeSourceUpload(input: {
    sourceKey: string;
    uploadId: string;
    parts: readonly ListedPart[];
    plan: PartPlan;
  }): Promise<boolean> {
    try {
      await this.storage.completeMultipartUpload({
        bucket: 'uploads',
        key: input.sourceKey,
        uploadId: input.uploadId,
        parts: input.parts,
        plan: input.plan,
      });
      return true;
    } catch (error) {
      if (isNoSuchUpload(error)) return false;
      throw toMediaStorageError(error);
    }
  }

  abortSourceUpload(sourceKey: string, uploadId: string): Promise<void> {
    return this.call(() =>
      this.storage.abortMultipartUpload({ bucket: 'uploads', key: sourceKey, uploadId }),
    );
  }

  async sourceSize(sourceKey: string): Promise<number | null> {
    const info = await this.call(() =>
      this.storage.headObject({ bucket: 'uploads', key: sourceKey }),
    );
    return info === null ? null : info.size;
  }

  deleteSource(sourceKey: string): Promise<void> {
    return this.call(() => this.storage.deleteObject({ bucket: 'uploads', key: sourceKey }));
  }

  readMediaText(key: string): Promise<string> {
    return this.call(() => this.storage.getObjectText({ bucket: 'media', key }));
  }

  presignMediaGet(
    key: string,
    options: {
      ttlSeconds: number;
      responseContentType?: string;
      responseContentDisposition?: string;
    },
  ): Promise<SignedObjectUrl> {
    return this.call(() => this.storage.presignGet({ bucket: 'media', key, ...options }));
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw toMediaStorageError(error);
    }
  }
}
