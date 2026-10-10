import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, type DB, type Kysely, sql } from '@udemy/db';
import { ObjectStorage, type StorageConfig } from '@udemy/storage';
import { afterAll, beforeAll } from 'vitest';

/**
 * Transcoder integration tests against the dev compose stack, same convention as the api/worker
 * (src/testing/integration.ts) and @udemy/storage (it-s3.ts):
 *
 * - IT_DATABASE_URL (default Postgres on 55432, migrated) and IT_S3_* (default MinIO on
 *   localhost:9000, minio/minio12345, udemy-uploads + udemy-media).
 * - Locally an unreachable dependency SKIPS the tests; with CI=true it FAILS them.
 * - Every row belongs to users this file creates and every object lives under those users' /
 *   assets' keys; `cleanup()` removes exactly those (append-only tables need
 *   `session_replication_role = replica`, i.e. the dev/CI superuser, as in @udemy/db's tests).
 */
export const IT_DEFAULT_DATABASE_URL = 'postgres://udemy:udemy@localhost:55432/udemy';

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
    maxAttempts: 2,
  };
}

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
  let db: Kysely<DB> | undefined;
  let storage: ObjectStorage | undefined;
  let reason: string | undefined = 'not connected yet';
  const users: string[] = [];
  const assets: string[] = [];

  beforeAll(async () => {
    db = createDatabase({
      connectionString: env('IT_DATABASE_URL', IT_DEFAULT_DATABASE_URL),
      max: 6,
      applicationName: 'udemy-transcoder-it',
    });
    storage = new ObjectStorage(itStorageConfig());
    try {
      await sql`select 1 from media.transcode_jobs limit 0`.execute(db);
      await storage.ping();
      reason = undefined;
    } catch (error) {
      reason =
        `Postgres/MinIO unreachable or unmigrated (${error instanceof Error ? error.message : String(error)}). ` +
        'Start infra/docker/docker-compose.dev.yml and run the migrations.';
      if (process.env.CI === 'true') throw new Error(`[integration] ${reason}`, { cause: error });
      process.stderr.write(`[integration] ${reason} Skipping.\n`);
    }
  });

  afterAll(async () => {
    try {
      if (reason === undefined && db !== undefined && storage !== undefined) {
        await cleanup(db, storage, users, assets);
      }
    } finally {
      storage?.destroy();
      await db?.destroy();
    }
  });

  return {
    get db(): Kysely<DB> {
      if (db === undefined || reason !== undefined) throw new Error(`[integration] ${reason}`);
      return db;
    },
    get storage(): ObjectStorage {
      if (storage === undefined || reason !== undefined) throw new Error(`[integration] ${reason}`);
      return storage;
    },
    get unavailableReason(): string | undefined {
      return reason;
    },
    skipIfUnavailable(ctx: SkippableContext): void {
      ctx.skip(reason !== undefined, reason);
    },
    async createUser(): Promise<string> {
      const row = await this.db
        .insertInto('identity.users')
        .values({
          email: `it-transcoder-${randomBytes(5).toString('hex')}@example.test`,
          displayName: 'IT transcoder user',
          passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$aXQ$aXQ',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      users.push(row.id);
      return row.id;
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
  await db.transaction().execute(async (trx) => {
    await sql`set local session_replication_role = replica`.execute(trx);
    if (assetIds.length > 0) {
      await sql`DELETE FROM outbox.events WHERE aggregate_type = 'media.asset' AND aggregate_id = ANY(${assetIds}::text[])`.execute(
        trx,
      );
      await sql`
        WITH a AS (SELECT unnest(${assetIds}::uuid[]) AS id)
        , d1 AS (DELETE FROM media.transcode_attempts WHERE asset_id IN (SELECT id FROM a))
        , d2 AS (DELETE FROM media.transcode_jobs WHERE asset_id IN (SELECT id FROM a))
        , d3 AS (DELETE FROM media.asset_renditions WHERE asset_id IN (SELECT id FROM a))
        DELETE FROM media.assets WHERE id IN (SELECT id FROM a)
      `.execute(trx);
    }
    await sql`DELETE FROM identity.users WHERE id = ANY(${[...users]}::uuid[])`.execute(trx);
  });
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
