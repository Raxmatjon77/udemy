import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import type { StorageConfig } from '../config';
import { ObjectStorage } from '../object-storage';

/**
 * The ONE convention for @udemy/storage integration tests (real MinIO), mirroring
 * apps/api/src/testing/integration.ts. No Testcontainers: the dev Docker VM has no memory for a
 * second MinIO.
 *
 * - `IT_S3_ENDPOINT` (default http://localhost:9000), `IT_S3_PUBLIC_ENDPOINT`
 *   (http://127.0.0.1:9000), `IT_S3_REGION` (us-east-1), `IT_S3_ACCESS_KEY` (minio),
 *   `IT_S3_SECRET_KEY` (minio12345), `IT_S3_BUCKET_UPLOADS` (udemy-uploads), `IT_S3_BUCKET_MEDIA`
 *   (udemy-media): the dev compose stack (infra/docker/docker-compose.dev.yml).
 * - Locally, an unreachable MinIO SKIPS the tests with a clear message; with `CI=true` it FAILS.
 *   A MinIO that answers but lacks a bucket, or stalls past PROBE_TIMEOUT_MS, always FAILS.
 * - Each file writes only under its own `it-<random>/` prefix in both buckets; afterAll aborts the
 *   multipart uploads and deletes the objects under that prefix, and nothing else.
 */
export const PROBE_TIMEOUT_MS = 25_000;

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function itStorageConfig(): StorageConfig {
  return {
    endpoint: env('IT_S3_ENDPOINT', 'http://localhost:9000'),
    publicEndpoint: env('IT_S3_PUBLIC_ENDPOINT', 'http://127.0.0.1:9000'),
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

export function isCi(): boolean {
  return process.env.CI === 'true';
}

export interface SkippableContext {
  skip(condition: boolean, note?: string): void;
}

export interface IntegrationS3 {
  /** Throws when MinIO is unavailable. */
  readonly storage: ObjectStorage;
  readonly config: StorageConfig;
  /** `it-<random>/`: every key a test writes must start with it. */
  readonly prefix: string;
  readonly unavailableReason: string | undefined;
  skipIfUnavailable(ctx: SkippableContext): void;
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET']);

function isUnreachable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (error instanceof AggregateError) return error.errors.some(isUnreachable);
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  return error instanceof Error && error.cause !== undefined && isUnreachable(error.cause);
}

/** Registers beforeAll/afterAll hooks: probe both buckets, then clean the prefix afterwards. */
export function useIntegrationS3(): IntegrationS3 {
  const config = itStorageConfig();
  const prefix = `it-${randomBytes(6).toString('hex')}/`;
  let storage: ObjectStorage | undefined;
  let reason: string | undefined = 'not connected yet (used outside a test?)';

  beforeAll(async () => {
    storage = new ObjectStorage(config);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        storage.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MinIO did not answer within ${PROBE_TIMEOUT_MS} ms`)),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      reason = undefined;
    } catch (error) {
      if (!isUnreachable(error)) {
        throw new Error(
          `[integration] MinIO at ${config.endpoint} answered but the probe failed ` +
            `(${error instanceof Error ? error.message : String(error)}). Check the buckets ` +
            `${config.buckets.uploads} / ${config.buckets.media} and the credentials.`,
          { cause: error },
        );
      }
      const why =
        `MinIO at ${config.endpoint} is unreachable. Start infra/docker/docker-compose.dev.yml ` +
        `or set IT_S3_ENDPOINT.`;
      if (isCi()) {
        throw new Error(`[integration] ${why} CI=true: integration tests must not be skipped.`, {
          cause: error,
        });
      }
      process.stderr.write(`[integration] ${why} Skipping its integration tests.\n`);
      reason = why;
    } finally {
      clearTimeout(timer);
    }
  });

  afterAll(async () => {
    if (storage === undefined) return;
    try {
      if (reason === undefined) {
        for (const bucket of ['uploads', 'media'] as const) {
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
    config,
    prefix,
    get unavailableReason(): string | undefined {
      return reason;
    },
    skipIfUnavailable(ctx: SkippableContext): void {
      ctx.skip(reason !== undefined, reason);
    },
  };
}
