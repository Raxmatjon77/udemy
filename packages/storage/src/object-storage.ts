import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type BucketRole, type StorageConfig, validateStorageConfig } from './config';
import {
  StorageEntityTooLargeError,
  StorageError,
  type StorageErrorContext,
  StorageNotFoundError,
  StorageUsageError,
  toStorageError,
} from './errors';
import { checkUploadedParts, type PartPlan, S3_MAX_PART_SIZE, S3_MAX_PARTS } from './part-plan';
import { createS3Clients, destroyS3Clients, type S3Clients } from './s3-clients';

/** SigV4 presigned URLs are valid for at most 7 days. */
export const MAX_PRESIGN_TTL_SECONDS = 604_800;
/** `DeleteObjects` accepts at most 1000 keys per request. */
export const DELETE_BATCH_SIZE = 1000;
/** Default cap for `getObjectText` (playlists, VTT): text objects are small. */
export const DEFAULT_MAX_TEXT_BYTES = 1024 * 1024;

export interface ObjectRef {
  readonly bucket: BucketRole;
  readonly key: string;
}

export interface MultipartRef extends ObjectRef {
  readonly uploadId: string;
}

export interface PresignedUrl {
  readonly url: string;
  /** When the signature expires (computed locally from the TTL). */
  readonly expiresAt: Date;
}

export interface PresignedUploadPart extends PresignedUrl {
  readonly partNumber: number;
  /** The signed Content-Length: the PUT body must be exactly this many bytes. */
  readonly contentLength: number;
}

declare const listedPartBrand: unique symbol;

/**
 * A part as reported by S3's `ListParts`. Branded so `completeMultipartUpload` can only be fed
 * server-listed parts, never ETags a client sent (design D10).
 */
export interface ListedPart {
  readonly partNumber: number;
  readonly size: number;
  readonly etag: string;
  readonly lastModified: Date | undefined;
  readonly [listedPartBrand]: true;
}

export interface MultipartUploadInfo {
  readonly key: string;
  readonly uploadId: string;
  readonly initiated: Date | undefined;
}

export interface ObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly etag: string | undefined;
  readonly contentType: string | undefined;
  readonly contentDisposition: string | undefined;
  readonly cacheControl: string | undefined;
  readonly lastModified: Date | undefined;
}

export interface ObjectSummary {
  readonly key: string;
  readonly size: number;
  readonly etag: string | undefined;
  readonly lastModified: Date | undefined;
}

export interface WriteOptions {
  readonly contentType: string;
  readonly cacheControl?: string;
  readonly contentDisposition?: string;
}

export interface PresignGetOptions {
  readonly ttlSeconds: number;
  /** `response-content-type` override, e.g. `application/octet-stream` for resources (D11). */
  readonly responseContentType?: string;
  /** `response-content-disposition`, e.g. `attachmentContentDisposition(name)` (D11). */
  readonly responseContentDisposition?: string;
  readonly responseCacheControl?: string;
}

export interface DeleteObjectsResult {
  readonly deleted: number;
  readonly errors: { key: string; code: string | undefined; message: string | undefined }[];
}

/**
 * The storage facade used by the api (media), the transcoder and the worker. All calls go to
 * `S3_ENDPOINT`; presigned URLs are signed for `S3_PUBLIC_ENDPOINT`. Every failure is a typed
 * error from `./errors`.
 *
 * Nest wiring (in the consuming app, which owns configuration and shutdown):
 *
 *   { provide: ObjectStorage, useFactory: () => new ObjectStorage(storageConfigFromEnv()) }
 *   // and call storage.destroy() from onApplicationShutdown
 */
export class ObjectStorage {
  private readonly config: StorageConfig;
  private readonly clients: S3Clients;
  private readonly ownsClients: boolean;

  constructor(config: StorageConfig, clients?: S3Clients) {
    this.config = validateStorageConfig(config);
    this.clients = clients ?? createS3Clients(this.config);
    this.ownsClients = clients === undefined;
  }

  /** Physical bucket name of a role. */
  bucketName(bucket: BucketRole): string {
    const name = this.config.buckets[bucket];
    if (name === undefined) throw new StorageUsageError(`Unknown bucket role "${String(bucket)}"`);
    return name;
  }

  /** Releases the sockets of clients this instance created. */
  destroy(): void {
    if (this.ownsClients) destroyS3Clients(this.clients);
  }

  /** HeadBucket on both buckets: a readiness probe. */
  async ping(): Promise<void> {
    for (const bucket of ['uploads', 'media'] as const) {
      const Bucket = this.bucketName(bucket);
      await this.send({ operation: 'ping', bucket: Bucket }, () =>
        this.clients.internal.send(new HeadBucketCommand({ Bucket })),
      );
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Multipart uploads
  // ---------------------------------------------------------------------------------------------

  /**
   * Starts a multipart upload. `contentType` must come from the purpose allowlist, never from the
   * browser verbatim; `contentDisposition` defaults to `attachment` (design §9).
   */
  async createMultipartUpload(
    input: ObjectRef & { contentType: string; contentDisposition?: string },
  ): Promise<{ uploadId: string }> {
    const { Bucket, Key } = this.target(input);
    assertHeaderValue(input.contentType, 'contentType');
    const contentDisposition = input.contentDisposition ?? 'attachment';
    assertHeaderValue(contentDisposition, 'contentDisposition');
    const out = await this.send(
      { operation: 'createMultipartUpload', bucket: Bucket, key: Key },
      () =>
        this.clients.internal.send(
          new CreateMultipartUploadCommand({
            Bucket,
            Key,
            ContentType: input.contentType,
            ContentDisposition: contentDisposition,
          }),
        ),
    );
    if (out.UploadId === undefined || out.UploadId === '') {
      throw new StorageError('unknown', 'CreateMultipartUpload returned no UploadId', {
        operation: 'createMultipartUpload',
        bucket: Bucket,
        key: Key,
      });
    }
    return { uploadId: out.UploadId };
  }

  /**
   * Presigns one UploadPart PUT with `content-length` in the SignedHeaders. MinIO rejects a body
   * of any other length with 403 SignatureDoesNotMatch, and a chunked body (no Content-Length)
   * with 411 MissingContentLength (T5 spike). Pass `partRange(plan, n).size`.
   */
  async presignUploadPart(
    input: MultipartRef & { partNumber: number; contentLength: number; ttlSeconds: number },
  ): Promise<PresignedUploadPart> {
    const { Bucket, Key } = this.target(input);
    assertUploadId(input.uploadId);
    if (
      !Number.isInteger(input.partNumber) ||
      input.partNumber < 1 ||
      input.partNumber > S3_MAX_PARTS
    ) {
      throw new StorageUsageError(`partNumber ${input.partNumber} is outside [1, ${S3_MAX_PARTS}]`);
    }
    if (
      !Number.isSafeInteger(input.contentLength) ||
      input.contentLength < 1 ||
      input.contentLength > S3_MAX_PART_SIZE
    ) {
      throw new StorageUsageError(`contentLength ${input.contentLength} is outside [1, 5 GiB]`);
    }
    assertTtl(input.ttlSeconds);
    const url = await this.send({ operation: 'presignUploadPart', bucket: Bucket, key: Key }, () =>
      getSignedUrl(
        this.clients.public,
        new UploadPartCommand({
          Bucket,
          Key,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
          ContentLength: input.contentLength,
        }),
        { expiresIn: input.ttlSeconds, signableHeaders: new Set(['content-length']) },
      ),
    );
    assertSignedContentLength(url);
    return {
      url,
      expiresAt: expiresAt(input.ttlSeconds),
      partNumber: input.partNumber,
      contentLength: input.contentLength,
    };
  }

  /** All uploaded parts, ascending (follows `ListParts` pagination; `pageSize` default 1000). */
  async listParts(input: MultipartRef & { pageSize?: number }): Promise<ListedPart[]> {
    const { Bucket, Key } = this.target(input);
    assertUploadId(input.uploadId);
    const parts: ListedPart[] = [];
    let marker: string | undefined;
    for (;;) {
      const page = await this.send({ operation: 'listParts', bucket: Bucket, key: Key }, () =>
        this.clients.internal.send(
          new ListPartsCommand({
            Bucket,
            Key,
            UploadId: input.uploadId,
            MaxParts: input.pageSize ?? 1000,
            PartNumberMarker: marker,
          }),
        ),
      );
      for (const part of page.Parts ?? []) {
        if (part.PartNumber === undefined || part.Size === undefined || part.ETag === undefined) {
          continue;
        }
        parts.push({
          partNumber: part.PartNumber,
          size: part.Size,
          etag: part.ETag,
          lastModified: part.LastModified,
        } as ListedPart);
      }
      const next = page.NextPartNumberMarker;
      if (page.IsTruncated !== true || next === undefined || next === marker) break;
      marker = next;
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  /**
   * Completes an upload with parts from `listParts` (never client ETags). With `plan`, the parts
   * must be exactly 1..partCount with the planned sizes, otherwise this throws before calling S3;
   * callers should run `checkUploadedParts` first to report `upload_incomplete` /
   * `upload_size_mismatch` precisely.
   */
  async completeMultipartUpload(
    input: MultipartRef & { parts: readonly ListedPart[]; plan?: PartPlan },
  ): Promise<{ etag: string | undefined }> {
    const { Bucket, Key } = this.target(input);
    assertUploadId(input.uploadId);
    if (input.parts.length === 0) {
      throw new StorageUsageError('completeMultipartUpload needs at least one part');
    }
    if (input.plan !== undefined) {
      const check = checkUploadedParts(input.plan, input.parts);
      if (!check.ok) {
        throw new StorageUsageError(
          `Uploaded parts do not match the plan (missing ${check.missing.length}, ` +
            `wrong size ${check.wrongSize.length}, unexpected ${check.unexpected.length})`,
        );
      }
    }
    const parts = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
    const out = await this.send(
      { operation: 'completeMultipartUpload', bucket: Bucket, key: Key },
      () =>
        this.clients.internal.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key,
            UploadId: input.uploadId,
            MultipartUpload: {
              Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
            },
          }),
        ),
    );
    return { etag: out.ETag };
  }

  /**
   * Aborts an upload. Idempotent: an upload S3 no longer knows (`NoSuchUpload`) counts as aborted.
   * MinIO answers 204 to a repeated abort of a real upload id and 404 NoSuchUpload only for ids it
   * never issued, so callers cannot use the outcome to tell "aborted now" from "already gone".
   */
  async abortMultipartUpload(input: MultipartRef): Promise<void> {
    const { Bucket, Key } = this.target(input);
    assertUploadId(input.uploadId);
    try {
      await this.send({ operation: 'abortMultipartUpload', bucket: Bucket, key: Key }, () =>
        this.clients.internal.send(
          new AbortMultipartUploadCommand({ Bucket, Key, UploadId: input.uploadId }),
        ),
      );
    } catch (error) {
      if (error instanceof StorageNotFoundError && error.s3Code === 'NoSuchUpload') return;
      throw error;
    }
  }

  /**
   * In-progress uploads whose key starts with `prefix` (janitor, design §5 step B). Paginates
   * lazily.
   *
   * The prefix is applied CLIENT-SIDE: MinIO's ListMultipartUploads treats `Prefix` as an exact
   * object key (T5 spike: `Prefix=it-x/` and `Prefix=it-x/uploads/` return nothing for an upload
   * at `it-x/uploads/a/b/source`; only the full key or no prefix lists it). Listing the whole
   * bucket and filtering is correct on both MinIO and S3; the quarantine bucket only holds
   * `uploads/...` keys anyway.
   */
  async *listMultipartUploads(input: {
    bucket: BucketRole;
    prefix: string;
  }): AsyncGenerator<MultipartUploadInfo> {
    const Bucket = this.bucketName(input.bucket);
    assertPrefix(input.prefix);
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (;;) {
      const page = await this.send({ operation: 'listMultipartUploads', bucket: Bucket }, () =>
        this.clients.internal.send(
          new ListMultipartUploadsCommand({
            Bucket,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
            MaxUploads: 1000,
          }),
        ),
      );
      for (const upload of page.Uploads ?? []) {
        if (upload.Key === undefined || upload.UploadId === undefined) continue;
        if (!upload.Key.startsWith(input.prefix)) continue;
        yield { key: upload.Key, uploadId: upload.UploadId, initiated: upload.Initiated };
      }
      if (page.IsTruncated !== true) break;
      if (page.NextKeyMarker === keyMarker && page.NextUploadIdMarker === uploadIdMarker) break;
      keyMarker = page.NextKeyMarker;
      uploadIdMarker = page.NextUploadIdMarker;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Objects
  // ---------------------------------------------------------------------------------------------

  /** Object metadata, or `null` when the object does not exist. */
  async headObject(input: ObjectRef): Promise<ObjectInfo | null> {
    const { Bucket, Key } = this.target(input);
    try {
      const out = await this.send({ operation: 'headObject', bucket: Bucket, key: Key }, () =>
        this.clients.internal.send(new HeadObjectCommand({ Bucket, Key })),
      );
      return {
        key: Key,
        size: out.ContentLength ?? 0,
        etag: out.ETag,
        contentType: out.ContentType,
        contentDisposition: out.ContentDisposition,
        cacheControl: out.CacheControl,
        lastModified: out.LastModified,
      };
    } catch (error) {
      if (error instanceof StorageNotFoundError && error.s3Code !== 'NoSuchBucket') return null;
      throw error;
    }
  }

  /**
   * Streams an object (or a byte range: `start` inclusive, `end` exclusive). The caller must
   * consume or destroy `body`, or the socket leaks.
   */
  async getObjectStream(
    input: ObjectRef & { range?: { start: number; end: number } },
  ): Promise<{ body: Readable; info: ObjectInfo }> {
    const { Bucket, Key } = this.target(input);
    const out = await this.get(Bucket, Key, input.range, 'getObjectStream');
    if (!(out.Body instanceof Readable)) {
      throw new StorageError('unknown', 'GetObject returned no stream body', {
        operation: 'getObjectStream',
        bucket: Bucket,
        key: Key,
      });
    }
    return { body: out.Body, info: infoFromGet(Key, out) };
  }

  /** Reads a byte range into memory (magic-byte checks). `end` is exclusive. */
  async getObjectRange(input: ObjectRef & { start: number; end: number }): Promise<Buffer> {
    const { Bucket, Key } = this.target(input);
    const out = await this.get(Bucket, Key, input, 'getObjectRange');
    const bytes = await this.send({ operation: 'getObjectRange', bucket: Bucket, key: Key }, () =>
      bodyOf(out).transformToByteArray(),
    );
    return Buffer.from(bytes);
  }

  /**
   * Reads a small UTF-8 object (HLS playlists, VTT). Refuses objects larger than `maxBytes`
   * (default 1 MiB) with `StorageEntityTooLargeError` before reading the body.
   */
  async getObjectText(input: ObjectRef & { maxBytes?: number }): Promise<string> {
    const { Bucket, Key } = this.target(input);
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_TEXT_BYTES;
    const out = await this.get(Bucket, Key, undefined, 'getObjectText');
    const body = bodyOf(out);
    if (out.ContentLength === undefined || out.ContentLength > maxBytes) {
      if (body instanceof Readable) body.destroy();
      throw new StorageEntityTooLargeError(
        `Object is larger than ${maxBytes} bytes (${out.ContentLength ?? 'unknown'})`,
        { operation: 'getObjectText', bucket: Bucket, key: Key },
      );
    }
    return this.send({ operation: 'getObjectText', bucket: Bucket, key: Key }, () =>
      body.transformToString('utf-8'),
    );
  }

  /**
   * Writes an object. A stream body needs `contentLength` (plain PutObject cannot stream an
   * unknown length); for files use `putFile`.
   *
   * There is deliberately no `If-None-Match` option: after answering 412 to a conditional PUT,
   * MinIO resets the keep-alive socket and the NEXT request on it fails with ECONNRESET (T5 spike).
   * Outputs are immutable per `a{outputVersion}` prefix, so create-only writes are not needed.
   */
  async putObject(
    input: ObjectRef &
      WriteOptions & {
        body: Buffer | Uint8Array | string | Readable;
        contentLength?: number;
      },
  ): Promise<{ etag: string | undefined }> {
    const { Bucket, Key } = this.target(input);
    assertWriteOptions(input);
    if (input.body instanceof Readable && input.contentLength === undefined) {
      throw new StorageUsageError('putObject with a stream body needs contentLength');
    }
    const out = await this.send({ operation: 'putObject', bucket: Bucket, key: Key }, () =>
      this.clients.internal.send(
        new PutObjectCommand({
          Bucket,
          Key,
          Body: input.body,
          ContentLength: input.contentLength,
          ContentType: input.contentType,
          CacheControl: input.cacheControl,
          ContentDisposition: input.contentDisposition,
        }),
      ),
    );
    return { etag: out.ETag };
  }

  /** Uploads a local file (transcoder outputs), streaming it with its exact length. */
  async putFile(
    input: ObjectRef & WriteOptions & { filePath: string },
  ): Promise<{ etag: string | undefined }> {
    const { size } = await stat(input.filePath);
    return this.putObject({
      ...input,
      body: createReadStream(input.filePath),
      contentLength: size,
    });
  }

  /**
   * Server-side copy (≤ 5 GiB, a single CopyObject). With any of the write options the metadata
   * is replaced (and `contentType` is then required by S3 semantics), otherwise copied.
   */
  async copyObject(input: {
    from: ObjectRef;
    to: ObjectRef;
    write?: WriteOptions;
  }): Promise<{ etag: string | undefined }> {
    const source = this.target(input.from);
    const { Bucket, Key } = this.target(input.to);
    if (input.write !== undefined) assertWriteOptions(input.write);
    const out = await this.send({ operation: 'copyObject', bucket: Bucket, key: Key }, () =>
      this.clients.internal.send(
        new CopyObjectCommand({
          Bucket,
          Key,
          CopySource: `${source.Bucket}/${source.Key.split('/').map(encodeURIComponent).join('/')}`,
          ...(input.write === undefined
            ? { MetadataDirective: 'COPY' as const }
            : {
                MetadataDirective: 'REPLACE' as const,
                ContentType: input.write.contentType,
                CacheControl: input.write.cacheControl,
                ContentDisposition: input.write.contentDisposition,
              }),
        }),
      ),
    );
    return { etag: out.CopyObjectResult?.ETag };
  }

  /** Deletes one object. Idempotent (S3 answers 204 for a missing key). */
  async deleteObject(input: ObjectRef): Promise<void> {
    const { Bucket, Key } = this.target(input);
    await this.send({ operation: 'deleteObject', bucket: Bucket, key: Key }, () =>
      this.clients.internal.send(new DeleteObjectCommand({ Bucket, Key })),
    );
  }

  /** Deletes keys in batches of 1000. Per-key failures are returned, not thrown. */
  async deleteObjects(input: {
    bucket: BucketRole;
    keys: readonly string[];
  }): Promise<DeleteObjectsResult> {
    const Bucket = this.bucketName(input.bucket);
    const keys = [...new Set(input.keys)];
    keys.forEach(assertKey);
    let deleted = 0;
    const errors: DeleteObjectsResult['errors'] = [];
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const batch = keys.slice(i, i + DELETE_BATCH_SIZE);
      const out = await this.send({ operation: 'deleteObjects', bucket: Bucket }, () =>
        this.clients.internal.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        ),
      );
      const failed = out.Errors ?? [];
      for (const e of failed) {
        errors.push({ key: e.Key ?? '', code: e.Code, message: e.Message });
      }
      deleted += batch.length - failed.length;
    }
    return { deleted, errors };
  }

  /** Objects under a non-empty prefix, in key order. Paginates lazily. */
  async *listObjects(input: {
    bucket: BucketRole;
    prefix: string;
    pageSize?: number;
  }): AsyncGenerator<ObjectSummary> {
    const Bucket = this.bucketName(input.bucket);
    assertPrefix(input.prefix);
    let token: string | undefined;
    for (;;) {
      const page = await this.send({ operation: 'listObjects', bucket: Bucket }, () =>
        this.clients.internal.send(
          new ListObjectsV2Command({
            Bucket,
            Prefix: input.prefix,
            ContinuationToken: token,
            MaxKeys: input.pageSize ?? 1000,
          }),
        ),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key === undefined) continue;
        yield {
          key: object.Key,
          size: object.Size ?? 0,
          etag: object.ETag,
          lastModified: object.LastModified,
        };
      }
      if (page.IsTruncated !== true || page.NextContinuationToken === undefined) break;
      token = page.NextContinuationToken;
    }
  }

  /**
   * Deletes every object under `prefix`, which must end with `/` (so `assets/a1` can never match
   * `assets/a10/`). Returns the number deleted; throws if any key could not be deleted.
   */
  async deletePrefix(input: { bucket: BucketRole; prefix: string }): Promise<number> {
    assertPrefix(input.prefix);
    if (!input.prefix.endsWith('/') || input.prefix.length < 2) {
      throw new StorageUsageError(
        `deletePrefix needs a prefix ending with "/" (got "${input.prefix}")`,
      );
    }
    let deleted = 0;
    let batch: string[] = [];
    const failures: DeleteObjectsResult['errors'] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const result = await this.deleteObjects({ bucket: input.bucket, keys: batch });
      deleted += result.deleted;
      failures.push(...result.errors);
      batch = [];
    };
    for await (const object of this.listObjects({ bucket: input.bucket, prefix: input.prefix })) {
      batch.push(object.key);
      if (batch.length >= DELETE_BATCH_SIZE) await flush();
    }
    await flush();
    if (failures.length > 0) {
      throw new StorageError(
        'unknown',
        `deletePrefix: ${failures.length} object(s) could not be deleted (first: ${failures[0]?.code ?? 'unknown'})`,
        { operation: 'deletePrefix', bucket: this.bucketName(input.bucket), key: input.prefix },
      );
    }
    return deleted;
  }

  // ---------------------------------------------------------------------------------------------
  // Presigned GET (udemy-media only)
  // ---------------------------------------------------------------------------------------------

  /**
   * Presigns a GET on the MEDIA bucket. The uploads bucket is quarantine and is never presigned
   * for GET (D11, §9): the parameter type only admits `'media'`, and any other value throws at
   * runtime as well (for callers that cast or come from JavaScript).
   */
  async presignGet(
    input: { bucket: 'media'; key: string } & PresignGetOptions,
  ): Promise<PresignedUrl> {
    if ((input.bucket as string) !== 'media') {
      throw new StorageUsageError(
        `Refusing to presign a GET on the "${String(input.bucket)}" bucket: only media is served`,
      );
    }
    const { Bucket, Key } = this.target(input);
    assertTtl(input.ttlSeconds);
    for (const [name, value] of [
      ['responseContentType', input.responseContentType],
      ['responseContentDisposition', input.responseContentDisposition],
      ['responseCacheControl', input.responseCacheControl],
    ] as const) {
      if (value !== undefined) assertHeaderValue(value, name);
    }
    const url = await this.send({ operation: 'presignGet', bucket: Bucket, key: Key }, () =>
      getSignedUrl(
        this.clients.public,
        new GetObjectCommand({
          Bucket,
          Key,
          ResponseContentType: input.responseContentType,
          ResponseContentDisposition: input.responseContentDisposition,
          ResponseCacheControl: input.responseCacheControl,
        }),
        { expiresIn: input.ttlSeconds },
      ),
    );
    return { url, expiresAt: expiresAt(input.ttlSeconds) };
  }

  // ---------------------------------------------------------------------------------------------

  private target(ref: ObjectRef): { Bucket: string; Key: string } {
    assertKey(ref.key);
    return { Bucket: this.bucketName(ref.bucket), Key: ref.key };
  }

  private async get(
    Bucket: string,
    Key: string,
    range: { start: number; end: number } | undefined,
    operation: string,
  ): Promise<GetObjectCommandOutput> {
    let Range: string | undefined;
    if (range !== undefined) {
      if (
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end <= range.start
      ) {
        throw new StorageUsageError(`Invalid byte range [${range.start}, ${range.end})`);
      }
      Range = `bytes=${range.start}-${range.end - 1}`;
    }
    return this.send({ operation, bucket: Bucket, key: Key }, () =>
      this.clients.internal.send(new GetObjectCommand({ Bucket, Key, Range })),
    );
  }

  private async send<T>(context: StorageErrorContext, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw toStorageError(error, context);
    }
  }
}

function bodyOf(out: GetObjectCommandOutput): NonNullable<GetObjectCommandOutput['Body']> {
  if (out.Body === undefined) {
    throw new StorageError('unknown', 'GetObject returned no body', { operation: 'getObject' });
  }
  return out.Body;
}

function infoFromGet(key: string, out: GetObjectCommandOutput): ObjectInfo {
  return {
    key,
    size: out.ContentLength ?? 0,
    etag: out.ETag,
    contentType: out.ContentType,
    contentDisposition: out.ContentDisposition,
    cacheControl: out.CacheControl,
    lastModified: out.LastModified,
  };
}

function expiresAt(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_PRESIGN_TTL_SECONDS) {
    throw new StorageUsageError(
      `ttlSeconds must be an integer within [1, ${MAX_PRESIGN_TTL_SECONDS}]`,
    );
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function assertKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key === '' ||
    key.startsWith('/') ||
    Buffer.byteLength(key) > 1024 ||
    CONTROL_CHARS.test(key)
  ) {
    throw new StorageUsageError(`Invalid object key "${String(key)}"`);
  }
}

function assertPrefix(prefix: string): void {
  if (typeof prefix !== 'string' || prefix === '') {
    throw new StorageUsageError('A non-empty prefix is required');
  }
  assertKey(prefix);
}

function assertUploadId(uploadId: string): void {
  if (typeof uploadId !== 'string' || uploadId === '' || CONTROL_CHARS.test(uploadId)) {
    throw new StorageUsageError('Invalid uploadId');
  }
}

function assertHeaderValue(value: string, name: string): void {
  if (value === '' || CONTROL_CHARS.test(value)) {
    throw new StorageUsageError(
      `${name} must be a non-empty header value without control characters`,
    );
  }
}

function assertWriteOptions(options: WriteOptions): void {
  assertHeaderValue(options.contentType, 'contentType');
  if (options.cacheControl !== undefined) assertHeaderValue(options.cacheControl, 'cacheControl');
  if (options.contentDisposition !== undefined) {
    assertHeaderValue(options.contentDisposition, 'contentDisposition');
  }
}

/**
 * Guards against SDK upgrades silently changing presigning: the part URL must sign
 * `content-length` and must not carry a precomputed body checksum.
 */
function assertSignedContentLength(url: string): void {
  const params = new URL(url).searchParams;
  const signed = (params.get('X-Amz-SignedHeaders') ?? '').split(';');
  const hasChecksum = [...params.keys()].some((k) => k.toLowerCase().startsWith('x-amz-checksum-'));
  if (!signed.includes('content-length') || hasChecksum) {
    throw new StorageUsageError(
      'Presigned UploadPart URL does not sign content-length (or carries a checksum); refusing it',
    );
  }
}
