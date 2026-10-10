import { randomBytes, randomUUID } from 'node:crypto';
import { type DB, type Kysely, sql } from '@udemy/db';
import { type ObjectStorage, resourceKey } from '@udemy/storage';
import { insertTestAsset } from './catalog-it';

/**
 * Integration/e2e fixtures for the public catalog (P2-T11): READY media whose OUTPUT objects
 * really exist in the media bucket (what the transcoder leaves behind, compressed into direct
 * SQL + PUTs, as media's own integration tests do), and in-flight assets for attach tests.
 * Object keys live under `assets/{assetId}/`, so `deleteMediaTestData` removes them.
 */

/** Small stand-ins for MPEG-TS segments (MinIO serves bytes, it never decodes them). */
export const FAKE_SEGMENT = randomBytes(2048);
export const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(512)]);
export const FAKE_PDF = Buffer.from('%PDF-1.4\n% catalog public fixture\n', 'utf8');

const VARIANT_PLAYLIST =
  '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
  '#EXTINF:6.000,\nseg_00000.ts\n#EXTINF:3.000,\nseg_00001.ts\n#EXT-X-ENDLIST\n';

const prefixOf = (assetId: string): string => `assets/${assetId}/a1/`;

/** A READY LECTURE_VIDEO with one HLS variant (`360p`), its playlist and two segments. */
export async function insertReadyVideo(
  db: Kysely<DB>,
  storage: ObjectStorage,
  ownerId: string,
  durationMs = 9_000,
): Promise<string> {
  const assetId = await insertTestAsset(db, { ownerId, purpose: 'LECTURE_VIDEO', durationMs });
  const prefix = prefixOf(assetId);
  await db
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
  await storage.putObject({
    bucket: 'media',
    key: `${prefix}hls/360p/index.m3u8`,
    body: VARIANT_PLAYLIST,
    contentType: 'application/vnd.apple.mpegurl',
  });
  for (const name of ['seg_00000.ts', 'seg_00001.ts']) {
    await storage.putObject({
      bucket: 'media',
      key: `${prefix}hls/360p/${name}`,
      body: FAKE_SEGMENT,
      contentType: 'video/mp2t',
    });
  }
  return assetId;
}

/** A READY COURSE_THUMBNAIL with its `w750` / `w480` JPEG renditions. */
export async function insertReadyThumbnail(
  db: Kysely<DB>,
  storage: ObjectStorage,
  ownerId: string,
): Promise<string> {
  const assetId = await insertTestAsset(db, { ownerId, purpose: 'COURSE_THUMBNAIL' });
  const prefix = prefixOf(assetId);
  for (const [name, width, height] of [
    ['w750', 750, 422],
    ['w480', 480, 270],
  ] as const) {
    await db
      .insertInto('media.assetRenditions')
      .values({ assetId, name, kind: 'IMAGE', width, height, objectKey: `${prefix}${name}.jpg` })
      .execute();
    await storage.putObject({
      bucket: 'media',
      key: `${prefix}${name}.jpg`,
      body: FAKE_JPEG,
      contentType: 'image/jpeg',
    });
  }
  return assetId;
}

/** A READY LECTURE_RESOURCE whose copied file exists. */
export async function insertReadyResource(
  db: Kysely<DB>,
  storage: ObjectStorage,
  ownerId: string,
): Promise<string> {
  const assetId = await insertTestAsset(db, { ownerId, purpose: 'LECTURE_RESOURCE' });
  await storage.putObject({
    bucket: 'media',
    key: resourceKey(prefixOf(assetId)),
    body: FAKE_PDF,
    contentType: 'application/octet-stream',
  });
  return assetId;
}

/** An asset still UPLOADING (or walked on to PROCESSING): attachable, not yet READY. */
export async function insertInFlightAsset(
  db: Kysely<DB>,
  options: {
    ownerId: string;
    purpose: 'LECTURE_VIDEO' | 'COURSE_THUMBNAIL';
    stage: 'UPLOADING' | 'PROCESSING';
  },
): Promise<string> {
  const assetId = randomUUID();
  const { ownerId, purpose } = options;
  await db
    .insertInto('media.assets')
    .values({
      id: assetId,
      ownerId,
      purpose,
      originalFilename: purpose === 'COURSE_THUMBNAIL' ? 'cover.png' : 'clip.mp4',
      declaredContentType: purpose === 'COURSE_THUMBNAIL' ? 'image/png' : 'video/mp4',
      declaredSizeBytes: '10000000',
      partSizeBytes: 8 * 1024 * 1024,
      partCount: 2,
      sourceKey: `uploads/${ownerId}/${assetId}/source`,
      s3UploadId: `catalog-public-it-${assetId}`,
    })
    .execute();
  if (options.stage === 'PROCESSING') {
    await sql`UPDATE media.assets SET status = 'UPLOADED', s3_upload_id = NULL, uploaded_at = now() WHERE id = ${assetId}`.execute(
      db,
    );
    await sql`UPDATE media.assets SET status = 'PROCESSING' WHERE id = ${assetId}`.execute(db);
  }
  return assetId;
}
