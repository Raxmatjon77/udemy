import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { leaseTranscodeJob, releaseTranscodeJob, sql } from '@udemy/db';
import { describe, expect, it } from 'vitest';
import { FfmpegToolchain } from '../ffmpeg/ffmpeg-toolchain.service';
import { MediaPipeline, type PipelineSettings } from '../pipeline/media-pipeline';
import { useFfmpeg } from '../testing/ffmpeg';
import { clip720, corruptVideo, PDF_BYTES, stillImage } from '../testing/fixtures';
import { seedUploadedAsset, useIntegrationStack } from '../testing/integration';
import { JobProcessor, type LeasedJob } from './job-processor';
import type { JobSettings } from './job-settings';
import { TranscodeNotifier } from './transcode-notifier';

/**
 * One job end to end against the dev Postgres + MinIO with the real ffmpeg: lease (job RUNNING +
 * asset PROCESSING + attempt, one transaction), pipeline, COMPLETE/FAIL + outbox. Skipped locally
 * when ffmpeg or the stack is missing; failing with CI=true.
 */
const ff = useFfmpeg();
const stack = useIntegrationStack();

const PIPELINE: PipelineSettings = {
  threads: 1,
  maxShortSide: 720,
  timeoutFactor: 4,
  maxSourceSeconds: 14_400,
  spritesEnabled: true,
  stallTimeoutMs: 120_000,
  killGraceMs: 2_000,
  minTimeoutMs: 300_000,
};

function settings(over: Partial<JobSettings> = {}): JobSettings {
  return {
    workerId: `it-transcoder-${randomBytes(4).toString('hex')}`,
    leaseMs: 30_000,
    heartbeatIntervalMs: 10_000,
    tmpDir: join(ff.dir, 'work'),
    maxAttempts: 3,
    concurrency: 1,
    pollIntervalMs: 1_000,
    ...over,
  };
}

function processorFor(jobSettings: JobSettings): JobProcessor {
  const pipeline = new MediaPipeline(new FfmpegToolchain(ff.paths), stack.storage, PIPELINE);
  return new JobProcessor(stack.db, pipeline, stack.storage, jobSettings);
}

/** Leases this test's job (back-dated to 1970, so first in order); refuses anyone else's. */
async function leaseMine(assetId: string, jobSettings: JobSettings): Promise<LeasedJob> {
  const lease = await leaseTranscodeJob(stack.db, {
    workerId: jobSettings.workerId,
    leaseMs: jobSettings.leaseMs,
  });
  if (lease?.kind === 'leased' && lease.assetId === assetId) return lease;
  if (lease?.kind === 'leased') {
    await releaseTranscodeJob(stack.db, {
      assetId: lease.assetId,
      workerId: jobSettings.workerId,
      leaseNo: lease.leaseNo,
    });
  }
  throw new Error(`expected to lease ${assetId}, got ${JSON.stringify(lease)}`);
}

const asset = (id: string) =>
  stack.db.selectFrom('media.assets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const job = (id: string) =>
  stack.db
    .selectFrom('media.transcodeJobs')
    .selectAll()
    .where('assetId', '=', id)
    .executeTakeFirstOrThrow();
const attempts = (id: string) =>
  stack.db
    .selectFrom('media.transcodeAttempts')
    .selectAll()
    .where('assetId', '=', id)
    .orderBy('attemptNo')
    .execute();
const renditions = (id: string) =>
  stack.db
    .selectFrom('media.assetRenditions')
    .selectAll()
    .where('assetId', '=', id)
    .orderBy('name')
    .execute();
const outbox = (id: string) =>
  stack.db
    .selectFrom('outbox.events')
    .select(['aggregateType', 'type', 'payload'])
    .where('aggregateId', '=', id)
    .orderBy('createdAt')
    .execute();

async function objectKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const object of stack.storage.listObjects({ bucket: 'media', prefix }))
    keys.push(object.key);
  return keys.sort();
}

describe('JobProcessor (dev Postgres + MinIO + ffmpeg)', () => {
  it('video: UPLOADED -> READY with renditions, objects in MinIO and a MediaReady outbox row', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    stack.skipIfUnavailable(ctx);
    const ownerId = await stack.createUser();
    const bytes = await readFile(await clip720(ff.paths, ff.dir));
    const id = await seedUploadedAsset(stack, {
      ownerId,
      purpose: 'LECTURE_VIDEO',
      contentType: 'video/mp4',
      bytes,
    });
    const jobSettings = settings();
    const lease = await leaseMine(id, jobSettings);
    expect(lease).toMatchObject({
      leaseNo: 1,
      attempts: 1,
      asset: { ownerId, purpose: 'LECTURE_VIDEO' },
    });
    expect((await asset(id)).status).toBe('PROCESSING');

    const outcome = await processorFor(jobSettings).run(lease, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'succeeded' });

    const row = await asset(id);
    expect(row).toMatchObject({
      status: 'READY',
      outputPrefix: `assets/${id}/a1/`,
      width: 1280,
      height: 720,
      detectedFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
      failureCode: null,
      sourceDeletedAt: null,
    });
    expect(row.durationMs).toBeGreaterThan(4900);
    expect(await job(id)).toMatchObject({
      status: 'SUCCEEDED',
      progressPct: 100,
      attempts: 1,
      leaseCount: 1,
      leaseOwner: null,
    });
    expect(await attempts(id)).toMatchObject([
      { attemptNo: 1, outcome: 'SUCCEEDED', workerId: jobSettings.workerId },
    ]);

    const rows = await renditions(id);
    expect(rows.map((r) => [r.name, r.kind, r.width, r.height, r.codecs])).toEqual([
      ['360p', 'HLS_VARIANT', 640, 360, 'avc1.4d401e,mp4a.40.2'],
      ['720p', 'HLS_VARIANT', 1280, 720, 'avc1.64001f,mp4a.40.2'],
      ['poster', 'IMAGE', 1280, 720, null],
      ['sprite', 'SPRITE', 160, 90, null],
    ]);
    expect(rows[1]?.bandwidthBps).toBeGreaterThan(100_000);

    const events = await outbox(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: 'media.asset',
      type: 'MediaReady.v1',
      payload: {
        assetId: id,
        ownerId,
        purpose: 'LECTURE_VIDEO',
        width: 1280,
        height: 720,
        renditions: ['360p', '720p', 'poster', 'sprite'],
      },
    });

    expect(await objectKeys(`assets/${id}/`)).toEqual([
      `assets/${id}/a1/hls/360p/index.m3u8`,
      `assets/${id}/a1/hls/360p/seg_00000.ts`,
      `assets/${id}/a1/hls/720p/index.m3u8`,
      `assets/${id}/a1/hls/720p/seg_00000.ts`,
      `assets/${id}/a1/poster.jpg`,
      `assets/${id}/a1/sprite.jpg`,
      `assets/${id}/a1/sprite.vtt`,
    ]);
    const playlist = await stack.storage.headObject({
      bucket: 'media',
      key: `assets/${id}/a1/hls/720p/index.m3u8`,
    });
    expect(playlist).toMatchObject({
      contentType: 'application/vnd.apple.mpegurl',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(
      await stack.storage.getObjectText({
        bucket: 'media',
        key: `assets/${id}/a1/hls/720p/index.m3u8`,
      }),
    ).toContain('seg_00000.ts');
    expect(
      (
        await stack.storage.headObject({
          bucket: 'media',
          key: `assets/${id}/a1/hls/360p/seg_00000.ts`,
        })
      )?.contentType,
    ).toBe('video/mp2t');
    // READY keeps the source (deleted after MEDIA_SOURCE_RETENTION_DAYS by the worker)
    expect(
      await stack.storage.headObject({ bucket: 'uploads', key: row.sourceKey }),
    ).not.toBeNull();
  });

  it('poison file: terminal FAILED (no retry), MediaFailed, source deleted', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    stack.skipIfUnavailable(ctx);
    const ownerId = await stack.createUser();
    const bytes = await readFile(await corruptVideo(ff.dir));
    const id = await seedUploadedAsset(stack, {
      ownerId,
      purpose: 'LECTURE_VIDEO',
      contentType: 'video/mp4',
      bytes,
    });
    const jobSettings = settings();
    const lease = await leaseMine(id, jobSettings);

    const outcome = await processorFor(jobSettings).run(lease, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'failed', code: 'INVALID_MEDIA' });

    const row = await asset(id);
    expect(row).toMatchObject({
      status: 'FAILED',
      failureCode: 'INVALID_MEDIA',
      outputPrefix: null,
    });
    expect(row.sourceDeletedAt).not.toBeNull();
    expect(await job(id)).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastErrorCode: 'INVALID_MEDIA',
    });
    const [attempt] = await attempts(id);
    expect(attempt).toMatchObject({ outcome: 'FAILED', errorCode: 'INVALID_MEDIA' });
    expect(attempt?.errorDetail).toMatch(/ffprobe/);
    expect(await outbox(id)).toMatchObject([
      {
        type: 'MediaFailed.v1',
        payload: {
          assetId: id,
          ownerId,
          purpose: 'LECTURE_VIDEO',
          failureCode: 'INVALID_MEDIA',
          attempts: 1,
        },
      },
    ]);
    expect(await stack.storage.headObject({ bucket: 'uploads', key: row.sourceKey })).toBeNull();
    expect(await objectKeys(`assets/${id}/`)).toEqual([]);
  });

  it('lost lease: heartbeat fencing aborts ffmpeg, nothing is written, outputs are discarded', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    stack.skipIfUnavailable(ctx);
    const ownerId = await stack.createUser();
    const bytes = await readFile(await clip720(ff.paths, ff.dir, 30));
    const id = await seedUploadedAsset(stack, {
      ownerId,
      purpose: 'LECTURE_VIDEO',
      contentType: 'video/mp4',
      bytes,
    });
    const jobSettings = settings({ heartbeatIntervalMs: 300 });
    const lease = await leaseMine(id, jobSettings);
    // Another transcoder took the job over (as after a reap + re-lease): the fence no longer matches.
    await sql`UPDATE media.transcode_jobs SET lease_owner = 'it-thief' WHERE asset_id = ${id}`.execute(
      stack.db,
    );

    const started = Date.now();
    const outcome = await processorFor(jobSettings).run(lease, new AbortController().signal);
    expect(outcome).toEqual({ kind: 'lease_lost' });
    expect(Date.now() - started).toBeLessThan(30_000);

    expect(await asset(id)).toMatchObject({ status: 'PROCESSING', outputPrefix: null });
    expect(await job(id)).toMatchObject({ status: 'RUNNING', leaseOwner: 'it-thief' });
    expect(await attempts(id)).toMatchObject([{ attemptNo: 1, outcome: null, finishedAt: null }]);
    expect(await renditions(id)).toEqual([]);
    expect(await outbox(id)).toEqual([]);
    expect(await objectKeys(`assets/${id}/`)).toEqual([]);
  });

  it('graceful shutdown: ffmpeg killed, lease released without an attempt penalty', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    stack.skipIfUnavailable(ctx);
    const ownerId = await stack.createUser();
    const bytes = await readFile(await clip720(ff.paths, ff.dir, 30));
    const id = await seedUploadedAsset(stack, {
      ownerId,
      purpose: 'LECTURE_VIDEO',
      contentType: 'video/mp4',
      bytes,
    });
    const jobSettings = settings();
    const lease = await leaseMine(id, jobSettings);
    const shutdown = new AbortController();
    const timer = setTimeout(() => shutdown.abort(), 1_500);

    const outcome = await processorFor(jobSettings).run(lease, shutdown.signal);
    clearTimeout(timer);
    expect(outcome).toEqual({ kind: 'released' });
    expect(await job(id)).toMatchObject({
      status: 'QUEUED',
      attempts: 0,
      leaseCount: 1,
      leaseOwner: null,
    });
    expect(await attempts(id)).toMatchObject([{ attemptNo: 1, outcome: 'RELEASED' }]);
    expect(await asset(id)).toMatchObject({ status: 'PROCESSING' });
    expect(await outbox(id)).toEqual([]);
    expect(await objectKeys(`assets/${id}/`)).toEqual([]);

    // The next lease gets a new fencing token / output version (a2), never a1 again.
    await sql`UPDATE media.transcode_jobs SET run_after = '1970-01-01T00:00:00Z' WHERE asset_id = ${id}`.execute(
      stack.db,
    );
    const next = await leaseMine(id, jobSettings);
    expect(next).toMatchObject({ leaseNo: 2, attempts: 1 });
    await releaseTranscodeJob(stack.db, {
      assetId: id,
      workerId: jobSettings.workerId,
      leaseNo: 2,
    });
  });

  it('thumbnail and resource: READY with the right objects', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    stack.skipIfUnavailable(ctx);
    const ownerId = await stack.createUser();
    const png = await readFile(await stillImage(ff.paths, ff.dir, 'png'));
    const thumb = await seedUploadedAsset(stack, {
      ownerId,
      purpose: 'COURSE_THUMBNAIL',
      contentType: 'image/png',
      bytes: png,
    });
    const jobSettings = settings();
    expect(
      await processorFor(jobSettings).run(
        await leaseMine(thumb, jobSettings),
        new AbortController().signal,
      ),
    ).toEqual({
      kind: 'succeeded',
    });
    expect(await asset(thumb)).toMatchObject({
      status: 'READY',
      width: 1600,
      height: 1200,
      durationMs: null,
    });
    expect((await renditions(thumb)).map((r) => `${r.name}=${r.width}x${r.height}`)).toEqual([
      'poster=1280x720',
      'w480=480x270',
      'w750=750x422',
    ]);
    expect(
      (await stack.storage.headObject({ bucket: 'media', key: `assets/${thumb}/a1/w750.jpg` }))
        ?.contentType,
    ).toBe('image/jpeg');

    const pdf = await seedUploadedAsset(stack, {
      ownerId,
      purpose: 'LECTURE_RESOURCE',
      contentType: 'application/pdf',
      bytes: PDF_BYTES,
    });
    expect(
      await processorFor(jobSettings).run(
        await leaseMine(pdf, jobSettings),
        new AbortController().signal,
      ),
    ).toEqual({
      kind: 'succeeded',
    });
    expect(await asset(pdf)).toMatchObject({
      status: 'READY',
      width: null,
      height: null,
      detectedFormat: 'pdf',
    });
    expect(
      await stack.storage.headObject({ bucket: 'media', key: `assets/${pdf}/a1/resource` }),
    ).toMatchObject({
      size: PDF_BYTES.length,
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
    });
    expect(await outbox(pdf)).toMatchObject([
      { type: 'MediaReady.v1', payload: { renditions: [], width: null, durationMs: null } },
    ]);
  });
});

describe('TranscodeNotifier', () => {
  it('LISTEN media_transcode wakes the loop when a job is enqueued', async (ctx) => {
    stack.skipIfUnavailable(ctx);
    let notified = 0;
    const notifier = new TranscodeNotifier({
      connectionString:
        process.env.IT_DATABASE_URL?.trim() || 'postgres://udemy:udemy@localhost:55432/udemy',
      applicationName: 'udemy-transcoder-it-listen',
      onNotify: () => {
        notified += 1;
      },
      logger: { log: () => undefined, warn: () => undefined },
    });
    notifier.start();
    try {
      await expect.poll(() => notifier.connected, { timeout: 10_000 }).toBe(true);
      const afterConnect = notified; // one wake-up on (re)connect
      const ownerId = await stack.createUser();
      const id = await seedUploadedAsset(stack, {
        ownerId,
        purpose: 'LECTURE_RESOURCE',
        contentType: 'application/pdf',
        bytes: PDF_BYTES,
      });
      await expect.poll(() => notified, { timeout: 10_000 }).toBeGreaterThan(afterConnect);
      await sql`UPDATE media.transcode_jobs SET status = 'CANCELLED', finished_at = now() WHERE asset_id = ${id}`.execute(
        stack.db,
      );
    } finally {
      await notifier.stop();
    }
  });
});
