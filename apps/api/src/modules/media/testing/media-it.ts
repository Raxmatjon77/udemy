import { randomUUID } from 'node:crypto';
import { type DB, type Kysely, sql } from '@udemy/db';
import { ObjectStorage, type StorageConfig } from '@udemy/storage';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll } from 'vitest';
import { deleteTestUsers, isCi, type SkippableContext } from '../../../testing/integration';

/**
 * Integration-test support for media against the dev MinIO, following the IT conventions of
 * `src/testing/integration.ts` and `@udemy/storage`'s `it-s3.ts`:
 *
 * - `IT_S3_ENDPOINT` (default http://localhost:9000), `IT_S3_PUBLIC_ENDPOINT`
 *   (http://127.0.0.1:9000), `IT_S3_REGION`, `IT_S3_ACCESS_KEY`, `IT_S3_SECRET_KEY`,
 *   `IT_S3_BUCKET_UPLOADS`, `IT_S3_BUCKET_MEDIA`: the dev compose stack.
 * - Unreachable MinIO: SKIP locally, FAIL with `CI=true`.
 * - Every object a test writes lives under keys derived from its own fresh owner/asset ids
 *   (`uploads/{owner}/...`, `assets/{asset}/...`); cleanup deletes exactly those prefixes.
 */
export const IT_S3_PROBE_TIMEOUT_MS = 25_000;

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/** The app's `S3_*` variables, pointed at the integration MinIO. */
export function itS3AppEnv(): Record<string, string> {
  return {
    S3_ENDPOINT: env('IT_S3_ENDPOINT', 'http://localhost:9000'),
    S3_PUBLIC_ENDPOINT: env('IT_S3_PUBLIC_ENDPOINT', 'http://127.0.0.1:9000'),
    S3_REGION: env('IT_S3_REGION', 'us-east-1'),
    S3_ACCESS_KEY: env('IT_S3_ACCESS_KEY', 'minio'),
    S3_SECRET_KEY: env('IT_S3_SECRET_KEY', 'minio12345'),
    S3_BUCKET_UPLOADS: env('IT_S3_BUCKET_UPLOADS', 'udemy-uploads'),
    S3_BUCKET_MEDIA: env('IT_S3_BUCKET_MEDIA', 'udemy-media'),
    S3_FORCE_PATH_STYLE: 'true',
  };
}

export function itStorageConfig(): StorageConfig {
  const e = itS3AppEnv();
  return {
    endpoint: e.S3_ENDPOINT ?? '',
    publicEndpoint: e.S3_PUBLIC_ENDPOINT ?? '',
    region: e.S3_REGION ?? '',
    accessKeyId: e.S3_ACCESS_KEY ?? '',
    secretAccessKey: e.S3_SECRET_KEY ?? '',
    forcePathStyle: true,
    buckets: { uploads: e.S3_BUCKET_UPLOADS ?? '', media: e.S3_BUCKET_MEDIA ?? '' },
    connectionTimeoutMs: 5_000,
    maxAttempts: 1,
  };
}

export interface IntegrationS3 {
  readonly storage: ObjectStorage;
  readonly available: boolean;
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

/** Registers beforeAll/afterAll hooks: a test-owned `ObjectStorage`, probed on both buckets. */
export function useIntegrationS3(): IntegrationS3 {
  let storage: ObjectStorage | undefined;
  let reason: string | undefined = 'not connected yet (used outside a test?)';

  beforeAll(async () => {
    const config = itStorageConfig();
    storage = new ObjectStorage(config);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        storage.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MinIO did not answer within ${IT_S3_PROBE_TIMEOUT_MS} ms`)),
            IT_S3_PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      reason = undefined;
    } catch (error) {
      if (!isUnreachable(error)) {
        throw new Error(
          `[integration] MinIO at ${config.endpoint} answered but the probe failed; check the ` +
            `buckets ${config.buckets.uploads} / ${config.buckets.media} and the credentials.`,
          { cause: error },
        );
      }
      const why = `MinIO at ${config.endpoint} is unreachable. Start infra/docker/docker-compose.dev.yml or set IT_S3_ENDPOINT.`;
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

  afterAll(() => {
    storage?.destroy();
  });

  return {
    get storage(): ObjectStorage {
      if (storage === undefined || reason !== undefined) {
        throw new Error(`[integration] MinIO is not available: ${reason ?? 'not connected'}`);
      }
      return storage;
    },
    get available(): boolean {
      return storage !== undefined && reason === undefined;
    },
    skipIfUnavailable(ctx: SkippableContext): void {
      ctx.skip(reason !== undefined, reason);
    },
  };
}

/** A user row for asset ownership (FK), without going through signup. */
export async function insertTestUser(db: Kysely<DB>, label: string): Promise<string> {
  const row = await db
    .insertInto('identity.users')
    .values({
      email: `media-it-${label}-${randomUUID().slice(0, 12)}@example.test`,
      displayName: `Media IT ${label}`,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$bm90LWEtcmVhbC1oYXNo$bm90LWEtcmVhbC1oYXNo',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Removes everything media tests wrote for these owners: S3 objects and multipart uploads
 * under their keys, then (replica mode: append-only renditions, FKs) outbox events, jobs,
 * usages, renditions and assets. `deleteUsers` also removes the users themselves.
 */
export async function deleteMediaTestData(
  db: Kysely<DB>,
  ownerIds: readonly string[],
  options: { storage?: ObjectStorage; redis?: Redis; deleteUsers?: boolean } = {},
): Promise<void> {
  const owners = [...new Set(ownerIds)];
  if (owners.length === 0) return;
  const assets = await db
    .selectFrom('media.assets')
    .select(['id', 'ownerId', 'sourceKey', 's3UploadId'])
    .where('ownerId', 'in', owners)
    .execute();
  const assetIds = assets.map((a) => a.id);

  const storage = options.storage;
  if (storage !== undefined) {
    for (const asset of assets) {
      if (asset.s3UploadId !== null) {
        await storage.abortMultipartUpload({
          bucket: 'uploads',
          key: asset.sourceKey,
          uploadId: asset.s3UploadId,
        });
      }
    }
    // Multipart uploads whose row was never written or already left UPLOADING.
    const ownerPrefixes = owners.map((o) => `uploads/${o}/`);
    for await (const upload of storage.listMultipartUploads({
      bucket: 'uploads',
      prefix: 'uploads/',
    })) {
      if (ownerPrefixes.some((p) => upload.key.startsWith(p))) {
        await storage.abortMultipartUpload({
          bucket: 'uploads',
          key: upload.key,
          uploadId: upload.uploadId,
        });
      }
    }
    for (const prefix of ownerPrefixes) await storage.deletePrefix({ bucket: 'uploads', prefix });
    for (const id of assetIds)
      await storage.deletePrefix({ bucket: 'media', prefix: `assets/${id}/` });
  }

  if (options.redis !== undefined) {
    await options.redis.del(
      ...owners.flatMap((o) => [`rl:media:initiate:u:${o}`, `rl:media:parts:u:${o}`]),
    );
  }

  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    if (assetIds.length > 0) {
      await trx.deleteFrom('outbox.events').where('aggregateId', 'in', assetIds).execute();
      await trx.deleteFrom('media.transcodeAttempts').where('assetId', 'in', assetIds).execute();
      await trx.deleteFrom('media.transcodeJobs').where('assetId', 'in', assetIds).execute();
      await trx.deleteFrom('media.assetUsages').where('assetId', 'in', assetIds).execute();
      await trx.deleteFrom('media.assetRenditions').where('assetId', 'in', assetIds).execute();
      await trx.deleteFrom('media.assets').where('id', 'in', assetIds).execute();
    }
  });
  if (options.deleteUsers === true) await deleteTestUsers(db, owners);
}
