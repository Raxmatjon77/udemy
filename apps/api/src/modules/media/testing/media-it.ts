import { randomUUID } from 'node:crypto';
import { type DB, type Kysely, sql } from '@udemy/db';
import type { ObjectStorage } from '@udemy/storage';
import { type IntegrationS3, itStorageConfig, useIntegrationS3 } from '@udemy/storage/testing';
import type { Redis } from 'ioredis';
import { deleteTestUsers } from '../../../testing/integration';

/**
 * Integration-test support for media against the dev MinIO. The S3 harness itself is
 * `@udemy/storage/testing` (`useIntegrationS3`: `IT_S3_*` variables, SKIP locally / FAIL with
 * `CI=true` when MinIO is unreachable); this file adds the app's `S3_*` env and media cleanup.
 *
 * Every object a test writes lives under keys derived from its own fresh owner/asset ids
 * (`uploads/{owner}/...`, `assets/{asset}/...`); `deleteMediaTestData` deletes exactly those
 * prefixes.
 */
export { useIntegrationS3 };
export type { IntegrationS3 };

/** The app's `S3_*` variables, pointed at the integration MinIO (`IT_S3_*`). */
export function itS3AppEnv(): Record<string, string> {
  const config = itStorageConfig();
  return {
    S3_ENDPOINT: config.endpoint,
    S3_PUBLIC_ENDPOINT: config.publicEndpoint,
    S3_REGION: config.region,
    S3_ACCESS_KEY: config.accessKeyId,
    S3_SECRET_KEY: config.secretAccessKey,
    S3_BUCKET_UPLOADS: config.buckets.uploads,
    S3_BUCKET_MEDIA: config.buckets.media,
    S3_FORCE_PATH_STYLE: 'true',
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
