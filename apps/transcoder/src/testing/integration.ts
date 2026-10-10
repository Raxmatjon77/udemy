import { randomUUID } from 'node:crypto';
import { type DB, type Kysely, sql } from '@udemy/db';
import { createUser, deleteTestData, useIntegrationDb } from '@udemy/db/testing';
import type { ObjectStorage } from '@udemy/storage';
import { itStorageConfig, useIntegrationS3 } from '@udemy/storage/testing';
import { afterAll } from 'vitest';

/**
 * Transcoder integration tests against the dev compose stack, on the shared harnesses:
 * `@udemy/db/testing` (`useIntegrationDb`: IT_DATABASE_URL, default Postgres on 55432, migrated)
 * and `@udemy/storage/testing` (`useIntegrationS3`: IT_S3_*, default MinIO on localhost:9000).
 *
 * - Locally an unreachable dependency SKIPS the tests; with CI=true it FAILS them.
 * - Every row belongs to users this file creates and every object lives under those users' /
 *   assets' keys; the afterAll cleanup removes exactly those (append-only tables need
 *   `session_replication_role = replica`, i.e. the dev/CI superuser, as in @udemy/db's tests).
 */
export interface SkippableContext {
  skip(condition: boolean, note?: string): void;
}

export interface IntegrationStack {
  readonly db: Kysely<DB>;
  readonly storage: ObjectStorage;
  readonly unavailableReason: string | undefined;
  skipIfUnavailable(ctx: SkippableContext): void;
  /** Inserts an identity user owned by this file (removed by cleanup). */
  createUser(): Promise<string>;
  /** Remembers an asset whose rows/objects cleanup must remove. */
  trackAsset(assetId: string): void;
}

export function useIntegrationStack(): IntegrationStack {
  const pg = useIntegrationDb({ max: 6 });
  // Two SDK attempts, as this file used before it moved to the shared harness.
  const s3 = useIntegrationS3({ config: { ...itStorageConfig(), maxAttempts: 2 } });
  const users: string[] = [];
  const assets: string[] = [];
  const reason = (): string | undefined => pg.unavailableReason ?? s3.unavailableReason;

  // Registered after both harnesses, so it runs before they close the pool and the S3 client.
  afterAll(async () => {
    if (reason() === undefined) await cleanup(pg.db, s3.storage, users, assets);
  });

  return {
    get db(): Kysely<DB> {
      return pg.db;
    },
    get storage(): ObjectStorage {
      return s3.storage;
    },
    get unavailableReason(): string | undefined {
      return reason();
    },
    skipIfUnavailable(ctx: SkippableContext): void {
      const why = reason();
      ctx.skip(why !== undefined, why);
    },
    async createUser(): Promise<string> {
      const id = await createUser(pg.db);
      users.push(id);
      return id;
    },
    trackAsset(assetId: string): void {
      assets.push(assetId);
    },
  };
}

async function cleanup(
  db: Kysely<DB>,
  storage: ObjectStorage,
  users: readonly string[],
  extraAssets: readonly string[],
): Promise<void> {
  if (users.length === 0) return;
  const owned = await db
    .selectFrom('media.assets')
    .select(['id', 'ownerId'])
    .where('ownerId', 'in', users)
    .execute();
  const assetIds = [...new Set([...owned.map((a) => a.id), ...extraAssets])];
  for (const id of assetIds) {
    await storage.deletePrefix({ bucket: 'media', prefix: `assets/${id}/` });
  }
  for (const owner of users) {
    await storage.deletePrefix({ bucket: 'uploads', prefix: `uploads/${owner}/` });
  }
  // Media events are keyed by asset id; deleteTestData removes the rest (assets, jobs,
  // attempts, renditions, the users) in replica mode.
  if (assetIds.length > 0) {
    await db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`DELETE FROM outbox.events WHERE aggregate_type = 'media.asset' AND aggregate_id = ANY(${assetIds}::text[])`.execute(
        trx,
      );
    });
  }
  await deleteTestData(db, users);
}

export const PART_SIZE = 5 * 1024 * 1024;

/**
 * An UPLOADED asset whose source object (`bytes`) is in the uploads bucket, plus its QUEUED
 * transcode job back-dated to 1970 so this file's job is the first in lease order on a shared dev
 * database. Walks the legal status edges like the api does.
 */
export async function seedUploadedAsset(
  stack: IntegrationStack,
  input: {
    ownerId: string;
    purpose: 'LECTURE_VIDEO' | 'COURSE_THUMBNAIL' | 'LECTURE_RESOURCE';
    contentType: string;
    bytes: Buffer;
  },
): Promise<string> {
  const id = randomUUID();
  stack.trackAsset(id);
  const size = input.bytes.length;
  const sourceKey = `uploads/${input.ownerId}/${id}/source`;
  await stack.storage.putObject({
    bucket: 'uploads',
    key: sourceKey,
    body: input.bytes,
    contentType: input.contentType,
  });
  const partSize = Math.max(PART_SIZE, size);
  await stack.db
    .insertInto('media.assets')
    .values({
      id,
      ownerId: input.ownerId,
      purpose: input.purpose,
      originalFilename: 'fixture',
      declaredContentType: input.contentType,
      declaredSizeBytes: String(size),
      partSizeBytes: partSize,
      partCount: 1,
      sourceKey,
      s3UploadId: `it-transcoder-${id}`,
    })
    .execute();
  await sql`UPDATE media.assets SET status = 'UPLOADED', s3_upload_id = NULL, uploaded_at = now() WHERE id = ${id}`.execute(
    stack.db,
  );
  await sql`INSERT INTO media.transcode_jobs (asset_id) VALUES (${id})`.execute(stack.db);
  await sql`UPDATE media.transcode_jobs SET run_after = '1970-01-01T00:00:00Z' WHERE asset_id = ${id}`.execute(
    stack.db,
  );
  return id;
}
