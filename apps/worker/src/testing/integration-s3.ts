import { ObjectStorage, type StorageConfig } from '@udemy/storage';
import { afterAll, beforeAll } from 'vitest';
import type { SkippableContext } from './integration';

/**
 * Worker integration tests against the dev MinIO, same variables and rules as the
 * `@udemy/storage` integration helper (which is not exported by the package):
 *
 * - `IT_S3_ENDPOINT` (default http://localhost:9000), `IT_S3_REGION` (us-east-1),
 *   `IT_S3_ACCESS_KEY` (minio), `IT_S3_SECRET_KEY` (minio12345), `IT_S3_BUCKET_UPLOADS`
 *   (udemy-uploads), `IT_S3_BUCKET_MEDIA` (udemy-media): the dev compose stack.
 * - Locally an unreachable MinIO SKIPS the tests; with `CI=true` it FAILS them.
 * - Tests only write keys that contain their own fresh UUIDs (`uploads/{owner}/{asset}/...`,
 *   `assets/{asset}/...`); `cleanupPrefixes` registers prefixes to empty (objects and multipart
 *   uploads) in afterAll.
 */
const PROBE_TIMEOUT_MS = 10_000;

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function itStorageConfig(): StorageConfig {
  const endpoint = env('IT_S3_ENDPOINT', 'http://localhost:9000');
  return {
    endpoint,
    publicEndpoint: endpoint,
    region: env('IT_S3_REGION', 'us-east-1'),
    accessKeyId: env('IT_S3_ACCESS_KEY', 'minio'),
    secretAccessKey: env('IT_S3_SECRET_KEY', 'minio12345'),
    forcePathStyle: true,
    buckets: {
      uploads: env('IT_S3_BUCKET_UPLOADS', 'udemy-uploads'),
      media: env('IT_S3_BUCKET_MEDIA', 'udemy-media'),
    },
    connectionTimeoutMs: 5_000,
    maxAttempts: 1,
  };
}

export interface IntegrationS3 {
  /** Throws when MinIO is unavailable. */
  readonly storage: ObjectStorage;
  readonly unavailableReason: string | undefined;
  skipIfUnavailable(ctx: SkippableContext): void;
  /** Empties `prefix` in `bucket` (objects + multipart uploads) after the file's tests. */
  cleanupPrefix(bucket: 'uploads' | 'media', prefix: string): void;
}

export function useIntegrationS3(): IntegrationS3 {
  let storage: ObjectStorage | undefined;
  let reason: string | undefined = 'not connected yet';
  const toClean: { bucket: 'uploads' | 'media'; prefix: string }[] = [];

  beforeAll(async () => {
    storage = new ObjectStorage(itStorageConfig());
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        storage.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer within ${PROBE_TIMEOUT_MS} ms`)),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      reason = undefined;
    } catch (error) {
      reason =
        `MinIO unreachable (${error instanceof Error ? error.message : String(error)}). ` +
        'Start infra/docker/docker-compose.dev.yml or set IT_S3_ENDPOINT.';
      if (process.env.CI === 'true') throw new Error(`[integration] ${reason}`, { cause: error });
      process.stderr.write(`[integration] ${reason} Skipping.\n`);
    } finally {
      clearTimeout(timer);
    }
  });

  afterAll(async () => {
    if (storage === undefined) return;
    try {
      if (reason === undefined) {
        for (const { bucket, prefix } of toClean) {
          for await (const upload of storage.listMultipartUploads({ bucket, prefix })) {
            await storage.abortMultipartUpload({
              bucket,
              key: upload.key,
              uploadId: upload.uploadId,
            });
          }
          await storage.deletePrefix({ bucket, prefix });
        }
      }
    } finally {
      storage.destroy();
    }
  });

  return {
    get storage(): ObjectStorage {
      if (storage === undefined || reason !== undefined) {
        throw new Error(`[integration] MinIO is not available: ${reason ?? 'not connected'}`);
      }
      return storage;
    },
    get unavailableReason(): string | undefined {
      return reason;
    },
    skipIfUnavailable(ctx: SkippableContext): void {
      ctx.skip(reason !== undefined, reason);
    },
    cleanupPrefix(bucket, prefix): void {
      toClean.push({ bucket, prefix });
    },
  };
}
