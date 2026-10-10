// Must stay the first import: AppModule validates process.env when it is imported.
import { MEDIA_IT_ENV, MEDIA_IT_LIMITS } from './testing/apply-media-it-env';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from '@udemy/db';
import { StorageNotFoundError } from '@udemy/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { useIntegrationDatabase, useIntegrationRedis } from '../../testing/integration';
import { MediaFacade } from './application/media.facade';
import { AbortUploadCommand } from './application/use-cases/abort-upload.command';
import { CompleteUploadCommand } from './application/use-cases/complete-upload.command';
import { GetUploadStatusQuery } from './application/use-cases/get-upload-status.query';
import { InitiateUploadCommand } from './application/use-cases/initiate-upload.command';
import { PresignPartsCommand } from './application/use-cases/presign-parts.command';
import {
  MediaAssetUnusable,
  PlaylistRejected,
  QuotaExceeded,
  TooManyUploads,
  UploadNotInProgress,
  UploadSizeMismatch,
} from './domain/media.errors';
import { deleteMediaTestData, insertTestUser, useIntegrationS3 } from './testing/media-it';

/*
 * The media module against the integration Postgres + Redis + MinIO (IT_DATABASE_URL,
 * IT_REDIS_URL, IT_S3_*; skipped locally when unreachable, a failure with CI=true), wired by
 * the real AppModule. Use cases are called directly; part bytes go to MinIO through the real
 * presigned URLs with fetch, exactly as a browser would send them.
 */
const MiB = 1024 * 1024;

describe('media (integration: real AppModule, Postgres, Redis, MinIO)', () => {
  const pg = useIntegrationDatabase({ max: 3 });
  const itRedis = useIntegrationRedis();
  const s3 = useIntegrationS3();
  const owners: string[] = [];
  let app: NestExpressApplication | undefined;

  const get = <T>(token: abstract new (...args: never[]) => T): T => {
    if (app === undefined) throw new Error('app not started');
    return app.get(token, { strict: false });
  };
  const available = (): boolean =>
    pg.available && itRedis.available && s3.unavailableReason === undefined;

  beforeAll(async () => {
    if (!available()) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (available()) {
        await deleteMediaTestData(pg.db, owners, {
          storage: s3.storage,
          redis: itRedis.redis,
          deleteUsers: true,
        });
      }
    } finally {
      await rm(MEDIA_IT_ENV.keysDir, { recursive: true, force: true });
      process.env = MEDIA_IT_ENV.savedEnv;
    }
  });

  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    pg.skipIfUnavailable(ctx);
    itRedis.skipIfUnavailable(ctx);
    s3.skipIfUnavailable(ctx);
  };

  async function owner(label: string): Promise<string> {
    const id = await insertTestUser(pg.db, label);
    owners.push(id);
    return id;
  }

  /** PUTs `body` to a presigned part URL, as the browser does (credentials never sent). */
  async function putPart(url: string, body: Buffer): Promise<Response> {
    return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  }

  /** Initiates, presigns and uploads every part of `bytes`; returns the asset id. */
  async function uploadVideo(ownerId: string, bytes: Buffer): Promise<string> {
    const init = await get(InitiateUploadCommand).execute({
      ownerId,
      purpose: 'LECTURE_VIDEO',
      filename: 'lesson.mp4',
      contentType: 'video/mp4',
      sizeBytes: bytes.length,
    });
    const partNumbers = Array.from({ length: init.partCount }, (_, i) => i + 1);
    const { urls } = await get(PresignPartsCommand).execute({
      ownerId,
      assetId: init.assetId,
      partNumbers,
    });
    for (const { partNumber, url } of urls) {
      const start = (partNumber - 1) * init.partSize;
      const res = await putPart(url, bytes.subarray(start, start + init.partSize));
      expect(res.status, await res.text()).toBe(200);
    }
    return init.assetId;
  }

  async function outboxTypes(assetId: string): Promise<string[]> {
    const rows = await pg.db
      .selectFrom('outbox.events')
      .select('type')
      .where('aggregateId', '=', assetId)
      .orderBy('createdAt')
      .execute();
    return rows.map((r) => r.type);
  }

  async function assetRow(assetId: string) {
    return pg.db
      .selectFrom('media.assets')
      .selectAll()
      .where('id', '=', assetId)
      .executeTakeFirstOrThrow();
  }

  it('round trip: initiate -> presigned PUTs (signed Content-Length) -> complete', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('roundtrip');
    const bytes = randomBytes(8 * MiB + 1234); // two parts: 8 MiB + 1234 B
    const init = await get(InitiateUploadCommand).execute({
      ownerId,
      purpose: 'LECTURE_VIDEO',
      filename: ' My lesson.MP4 ',
      contentType: 'video/mp4',
      sizeBytes: bytes.length,
    });
    expect(init).toMatchObject({ partSize: 8 * MiB, partCount: 2 });
    const row = await assetRow(init.assetId);
    expect(row).toMatchObject({
      status: 'UPLOADING',
      originalFilename: 'My lesson.MP4',
      declaredSizeBytes: String(bytes.length),
      sourceKey: `uploads/${ownerId}/${init.assetId}/source`,
    });

    const { urls } = await get(PresignPartsCommand).execute({
      ownerId,
      assetId: init.assetId,
      partNumbers: [1, 2],
    });
    const part2 = bytes.subarray(8 * MiB);
    // A body of any other length than the signed one is refused by MinIO (D10).
    const tampered = await putPart(urls[1]?.url ?? '', Buffer.concat([part2, Buffer.from('x')]));
    expect(tampered.status).toBe(403);
    await tampered.arrayBuffer();
    for (const { partNumber, url } of urls) {
      const res = await putPart(url, partNumber === 1 ? bytes.subarray(0, 8 * MiB) : part2);
      expect(res.status).toBe(200);
    }
    const status = await get(GetUploadStatusQuery).execute(init.assetId);
    expect(status.uploadedParts).toEqual([
      { partNumber: 1, size: 8 * MiB },
      { partNumber: 2, size: 1234 },
    ]);

    const view = await get(CompleteUploadCommand).execute({ ownerId, assetId: init.assetId });
    expect(view).toMatchObject({ id: init.assetId, status: 'UPLOADED', sizeBytes: bytes.length });
    expect(await assetRow(init.assetId)).toMatchObject({ status: 'UPLOADED', s3UploadId: null });
    const head = await s3.storage.headObject({ bucket: 'uploads', key: row.sourceKey });
    expect(head).toMatchObject({
      size: bytes.length,
      contentType: 'video/mp4',
      contentDisposition: 'attachment',
    });
    const event = await pg.db
      .selectFrom('outbox.events')
      .select(['type', 'aggregateType', 'payload'])
      .where('aggregateId', '=', init.assetId)
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      type: 'MediaUploaded.v1',
      aggregateType: 'media.asset',
      payload: {
        assetId: init.assetId,
        ownerId,
        purpose: 'LECTURE_VIDEO',
        sizeBytes: bytes.length,
      },
    });
  });

  it('complete is idempotent, also when two completes race', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('idempotent');
    const assetId = await uploadVideo(ownerId, randomBytes(3000));
    const complete = get(CompleteUploadCommand);

    const [a, b] = await Promise.all([
      complete.execute({ ownerId, assetId }),
      complete.execute({ ownerId, assetId }),
    ]);
    const again = await complete.execute({ ownerId, assetId });

    expect(a.status).toBe('UPLOADED');
    expect(b).toEqual(a);
    expect(again).toEqual(a);
    expect(await outboxTypes(assetId)).toEqual(['MediaUploaded.v1']);
  });

  it('rejects a size mismatch: FAILED + MediaFailed, upload aborted (422)', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('mismatch');
    const init = await get(InitiateUploadCommand).execute({
      ownerId,
      purpose: 'COURSE_THUMBNAIL',
      filename: 'cover.png',
      contentType: 'image/png',
      sizeBytes: 1000,
    });
    const row = await assetRow(init.assetId);
    // A URL signed for a different length (as a buggy or hostile signer would): MinIO accepts
    // the 999-byte part, and only the server-side ListParts check catches it.
    const forged = await s3.storage.presignUploadPart({
      bucket: 'uploads',
      key: row.sourceKey,
      uploadId: row.s3UploadId ?? '',
      partNumber: 1,
      contentLength: 999,
      ttlSeconds: 60,
    });
    expect((await putPart(forged.url, randomBytes(999))).status).toBe(200);

    await expect(
      get(CompleteUploadCommand).execute({ ownerId, assetId: init.assetId }),
    ).rejects.toBeInstanceOf(UploadSizeMismatch);
    expect(await assetRow(init.assetId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'UPLOAD_SIZE_MISMATCH',
      s3UploadId: null,
    });
    expect(await outboxTypes(init.assetId)).toEqual(['MediaFailed.v1']);
    await expect(
      s3.storage.listParts({
        bucket: 'uploads',
        key: row.sourceKey,
        uploadId: row.s3UploadId ?? '',
      }),
    ).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await s3.storage.headObject({ bucket: 'uploads', key: row.sourceKey })).toBeNull();
  });

  it('enforces the per-owner quota (422 quota_exceeded) without creating an S3 upload', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('quota');
    const initiate = get(InitiateUploadCommand);
    const video = (sizeBytes: number) =>
      initiate.execute({
        ownerId,
        purpose: 'LECTURE_VIDEO',
        filename: 'big.mp4',
        contentType: 'video/mp4',
        sizeBytes,
      });

    await video(MEDIA_IT_LIMITS.quotaBytes - 10 * MiB);
    await expect(video(10 * MiB + 1)).rejects.toBeInstanceOf(QuotaExceeded);
    await video(10 * MiB); // exactly at the quota is fine

    const rows = await pg.db
      .selectFrom('media.assets')
      .select('id')
      .where('ownerId', '=', ownerId)
      .execute();
    expect(rows).toHaveLength(2);
    let uploads = 0;
    for await (const upload of s3.storage.listMultipartUploads({
      bucket: 'uploads',
      prefix: 'uploads/',
    })) {
      if (upload.key.startsWith(`uploads/${ownerId}/`)) uploads += 1;
    }
    expect(uploads).toBe(2);
  });

  it('limits concurrent uploads per owner (429 too_many_uploads)', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('concurrency');
    const initiate = (): ReturnType<InitiateUploadCommand['execute']> =>
      get(InitiateUploadCommand).execute({
        ownerId,
        purpose: 'LECTURE_RESOURCE',
        filename: 'notes.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
      });

    // Concurrent initiates serialise on the advisory lock: exactly the limit gets through.
    const results = await Promise.allSettled(
      Array.from({ length: MEDIA_IT_LIMITS.maxConcurrentUploads + 2 }, () => initiate()),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    expect(ok).toHaveLength(MEDIA_IT_LIMITS.maxConcurrentUploads);
    expect(rejected.every((e) => e instanceof TooManyUploads)).toBe(true);

    // Aborting one frees a slot.
    const first = ok[0];
    if (first?.status !== 'fulfilled') throw new Error('unreachable');
    await get(AbortUploadCommand).execute({ ownerId, assetId: first.value.assetId });
    await expect(initiate()).resolves.toBeDefined();
  });

  it('abort: ABORTED in the DB, multipart gone in S3, then 409 for abort/complete', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('abort');
    const assetId = await uploadVideo(ownerId, randomBytes(2048));
    const row = await assetRow(assetId);

    await get(AbortUploadCommand).execute({ ownerId, assetId });

    expect(await assetRow(assetId)).toMatchObject({ status: 'ABORTED', s3UploadId: null });
    await expect(
      s3.storage.listParts({
        bucket: 'uploads',
        key: row.sourceKey,
        uploadId: row.s3UploadId ?? '',
      }),
    ).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(get(AbortUploadCommand).execute({ ownerId, assetId })).rejects.toBeInstanceOf(
      UploadNotInProgress,
    );
    await expect(get(CompleteUploadCommand).execute({ ownerId, assetId })).rejects.toBeInstanceOf(
      UploadNotInProgress,
    );
    await expect(
      get(PresignPartsCommand).execute({ ownerId, assetId, partNumbers: [1] }),
    ).rejects.toBeInstanceOf(UploadNotInProgress);
  });

  /** A READY video with one HLS variant whose objects are really in the media bucket. */
  async function readyVideoWithPlaylist(ownerId: string, playlist: (prefix: string) => string) {
    const assetId = await uploadVideo(ownerId, randomBytes(1024));
    await get(CompleteUploadCommand).execute({ ownerId, assetId });
    const prefix = `assets/${assetId}/a1/`;
    // What the transcoder does (schema doc §8.1), compressed into direct SQL.
    await pg.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('media.assets')
        .set({ status: 'PROCESSING' })
        .where('id', '=', assetId)
        .execute();
      await trx
        .updateTable('media.assets')
        .set({
          status: 'READY',
          outputPrefix: prefix,
          durationMs: 9000,
          width: 640,
          height: 360,
          readyAt: sql<Date>`now()`,
        })
        .where('id', '=', assetId)
        .execute();
      await trx
        .insertInto('media.assetRenditions')
        .values({
          assetId,
          name: '360p',
          kind: 'HLS_VARIANT',
          width: 640,
          height: 360,
          bandwidthBps: 800_000,
          codecs: 'avc1.42c01e,mp4a.40.2',
          objectKey: `${prefix}hls/360p/index.m3u8`,
        })
        .execute();
    });
    await s3.storage.putObject({
      bucket: 'media',
      key: `${prefix}hls/360p/index.m3u8`,
      body: playlist(prefix),
      contentType: 'application/vnd.apple.mpegurl',
    });
    return { assetId, prefix };
  }

  it('renders the master and rewrites the variant to presigned segment GETs that work', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('playlist');
    const { assetId, prefix } = await readyVideoWithPlaylist(
      ownerId,
      () =>
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
        '#EXTINF:6.000,\nseg_00000.ts\n#EXTINF:3.000,\nseg_00001.ts\n#EXT-X-ENDLIST\n',
    );
    const segment = randomBytes(4096);
    for (const name of ['seg_00000.ts', 'seg_00001.ts']) {
      await s3.storage.putObject({
        bucket: 'media',
        key: `${prefix}hls/360p/${name}`,
        body: segment,
        contentType: 'video/mp2t',
      });
    }
    const facade = get(MediaFacade);

    const master = await facade.renderMasterPlaylist(assetId);
    expect(master).toContain('#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360');
    expect(master).toContain('\n360p.m3u8\n');

    const variant = await facade.renderVariantPlaylist(assetId, '360p');
    const urls = variant.split('\n').filter((l) => l.startsWith('http'));
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url.startsWith(`http://127.0.0.1:9000/`)).toBe(true);
      expect(url).toContain('X-Amz-Expires=3600');
    }
    const res = await fetch(urls[0] ?? '');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(segment)).toBe(true);
    expect(variant).toContain('#EXT-X-ENDLIST');
  });

  it('refuses to sign a playlist whose segment URI escapes its directory', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('traversal');
    const victim = await readyVideoWithPlaylist(
      ownerId,
      () => '#EXTM3U\n#EXTINF:6,\nseg_00000.ts\n',
    );
    const { assetId } = await readyVideoWithPlaylist(
      ownerId,
      () => `#EXTM3U\n#EXTINF:6,\n../../../../${victim.prefix}hls/360p/seg_00000.ts\n`,
    );

    await expect(get(MediaFacade).renderVariantPlaylist(assetId, '360p')).rejects.toBeInstanceOf(
      PlaylistRejected,
    );
  });

  it('use/release keep the trigger-maintained unused_since exact', async (ctx) => {
    skip(ctx);
    const ownerId = await owner('usage');
    const assetId = await uploadVideo(ownerId, randomBytes(512));
    const consumer = { type: 'catalog.lecture', id: ownerId } as const; // any uuid
    const facade = get(MediaFacade);

    await pg.db
      .transaction()
      .execute((trx) =>
        facade.useAsset(trx, { assetId, ownerId, purpose: 'LECTURE_VIDEO', consumer }),
      );
    expect((await assetRow(assetId)).unusedSince).toBeNull();
    // Another lecture cannot take the same asset (asset_usages_asset_id_working_uq).
    await expect(
      pg.db.transaction().execute((trx) =>
        facade.useAsset(trx, {
          assetId,
          ownerId,
          purpose: 'LECTURE_VIDEO',
          consumer: { type: 'catalog.lecture', id: assetId },
        }),
      ),
    ).rejects.toBeInstanceOf(MediaAssetUnusable);

    await pg.db.transaction().execute((trx) => facade.releaseAsset(trx, { assetId, consumer }));
    expect((await assetRow(assetId)).unusedSince).toBeInstanceOf(Date);
  });
});
