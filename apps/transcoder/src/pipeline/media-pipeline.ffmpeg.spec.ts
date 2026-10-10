import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaPurpose } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { FfmpegToolchain } from '../ffmpeg/ffmpeg-toolchain.service';
import { runProcess } from '../ffmpeg/process';
import { buildProbeArgs } from '../ffmpeg/probe';
import { FakeStorage } from '../testing/fake-storage';
import { useFfmpeg } from '../testing/ffmpeg';
import {
  clip720,
  concatTrap,
  corruptVideo,
  declaredTooLong,
  GIF_BYTES,
  hlsPlaylistTrap,
  PDF_BYTES,
  pngHeader,
  pngVideoPolyglot,
  portraitClip,
  silentClip,
  stillImage,
} from '../testing/fixtures';
import { TranscodeFailure } from './failure';
import { MediaPipeline, type PipelineResult, type PipelineSettings } from './media-pipeline';

/**
 * The real ffmpeg/ffprobe against lavfi-generated fixtures (skipped locally without ffmpeg >= 6,
 * failing with CI=true). Storage is an in-memory fake; the integration spec covers MinIO + DB.
 */
const ff = useFfmpeg();

const SETTINGS: PipelineSettings = {
  threads: 1,
  maxShortSide: 720,
  timeoutFactor: 4,
  maxSourceSeconds: 14_400,
  spritesEnabled: true,
  stallTimeoutMs: 120_000,
  killGraceMs: 2_000,
  minTimeoutMs: 300_000,
};

const OWNER = '0190f0f0-0000-7000-8000-000000000001';

interface Run {
  readonly storage: FakeStorage;
  readonly assetId: string;
  readonly progress: number[];
  readonly result: Promise<PipelineResult>;
}

async function run(
  purpose: MediaPurpose,
  source: Buffer,
  options: { settings?: Partial<PipelineSettings>; signal?: AbortSignal } = {},
): Promise<Run> {
  const storage = new FakeStorage();
  const assetId = randomUUID();
  const sourceKey = `uploads/${OWNER}/${assetId}/source`;
  storage.put({ bucket: 'uploads', key: sourceKey }, source);
  const pipeline = new MediaPipeline(new FfmpegToolchain(ff.paths), storage.asObjectStorage(), {
    ...SETTINGS,
    ...options.settings,
  });
  const workDir = await mkdtemp(join(ff.dir, 'job-'));
  const progress: number[] = [];
  const result = pipeline
    .process({
      assetId,
      leaseNo: 1,
      purpose,
      sourceKey,
      declaredSizeBytes: source.length,
      workDir,
      signal: options.signal ?? new AbortController().signal,
      reportProgress: (pct) => progress.push(pct),
    })
    .finally(() => rm(workDir, { recursive: true, force: true }));
  return { storage, assetId, progress, result };
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TranscodeFailure) return error.code;
    throw error;
  }
  return 'OK';
}

describe('LECTURE_VIDEO', () => {
  it('5 s 720p clip: 360p + 720p HLS v3, poster, sprite; uploads with types and caching', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const { storage, assetId, progress, result } = await run(
      'LECTURE_VIDEO',
      await readFile(await clip720(ff.paths, ff.dir)),
    );
    const out = await result;
    const prefix = `assets/${assetId}/a1/`;

    expect(out).toMatchObject({
      width: 1280,
      height: 720,
      detectedFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
    });
    expect(out.durationMs).toBeGreaterThanOrEqual(4900);
    expect(out.durationMs).toBeLessThanOrEqual(5100);
    expect(out.renditions.map((r) => [r.name, r.kind, r.width, r.height, r.codecs])).toEqual([
      ['360p', 'HLS_VARIANT', 640, 360, 'avc1.4d401e,mp4a.40.2'],
      ['720p', 'HLS_VARIANT', 1280, 720, 'avc1.64001f,mp4a.40.2'],
      ['poster', 'IMAGE', 1280, 720, null],
      ['sprite', 'SPRITE', 160, 90, null],
    ]);
    for (const r of out.renditions.slice(0, 2)) {
      expect(r.bandwidthBps).toBeGreaterThan(100_000);
      expect(r.objectKey).toBe(`${prefix}hls/${r.name}/index.m3u8`);
    }

    expect(storage.keys('media')).toEqual([
      `${prefix}hls/360p/index.m3u8`,
      `${prefix}hls/360p/seg_00000.ts`,
      `${prefix}hls/720p/index.m3u8`,
      `${prefix}hls/720p/seg_00000.ts`,
      `${prefix}poster.jpg`,
      `${prefix}sprite.jpg`,
      `${prefix}sprite.vtt`,
    ]);
    const playlist = storage.get({ bucket: 'media', key: `${prefix}hls/720p/index.m3u8` });
    expect(playlist?.contentType).toBe('application/vnd.apple.mpegurl');
    expect(playlist?.cacheControl).toBe('public, max-age=31536000, immutable');
    expect(playlist?.body.toString()).toContain('#EXT-X-VERSION:3');
    expect(playlist?.body.toString()).toMatch(/\nseg_00000\.ts\n/);
    const segment = storage.get({ bucket: 'media', key: `${prefix}hls/720p/seg_00000.ts` });
    expect(segment?.contentType).toBe('video/mp2t');
    expect(segment?.body[0]).toBe(0x47); // MPEG-TS sync byte
    expect(
      storage.get({ bucket: 'media', key: `${prefix}poster.jpg` })?.body.subarray(0, 3),
    ).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(storage.get({ bucket: 'media', key: `${prefix}sprite.vtt` })?.contentType).toBe(
      'text/vtt; charset=utf-8',
    );
    expect(storage.get({ bucket: 'media', key: `${prefix}sprite.vtt` })?.body.toString()).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nsprite.jpg#xywh=0,0,160,90\n',
    );

    // progress is reported from the encoder, monotonic in effect and below 100
    expect(Math.max(...progress)).toBeGreaterThanOrEqual(90);
    expect(Math.max(...progress)).toBeLessThan(100);
  });

  it('portrait clip: the ladder follows the short side (360x640)', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const { result } = await run(
      'LECTURE_VIDEO',
      await readFile(await portraitClip(ff.paths, ff.dir)),
    );
    const out = await result;
    expect(out).toMatchObject({ width: 540, height: 960 });
    expect(out.renditions.map((r) => `${r.name}=${r.width}x${r.height}`)).toEqual([
      '360p=360x640',
      'poster=360x640',
      'sprite=90x160',
    ]);
  });

  it('audio-less Matroska clip: video-only variants, sprites disabled', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const { storage, assetId, result } = await run(
      'LECTURE_VIDEO',
      await readFile(await silentClip(ff.paths, ff.dir)),
      { settings: { spritesEnabled: false } },
    );
    const out = await result;
    expect(out.detectedFormat).toBe('matroska,webm');
    expect(out.renditions.map((r) => [r.name, r.codecs])).toEqual([
      ['360p', 'avc1.4d401e'],
      ['poster', null],
    ]);
    expect(storage.keys('media')).not.toContain(`assets/${assetId}/a1/sprite.vtt`);
  });

  it('corrupt file with a valid ftyp: INVALID_MEDIA, nothing uploaded', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const { storage, result } = await run(
      'LECTURE_VIDEO',
      await readFile(await corruptVideo(ff.dir)),
    );
    expect(await failureCode(result)).toBe('INVALID_MEDIA');
    expect(storage.keys('media')).toEqual([]);
  });

  it('PNG/MP4 polyglot: UNSUPPORTED_MEDIA by magic bytes', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const { result } = await run(
      'LECTURE_VIDEO',
      await readFile(await pngVideoPolyglot(ff.paths, ff.dir)),
    );
    expect(await failureCode(result)).toBe('UNSUPPORTED_MEDIA');
  });

  it('HLS playlist upload (local file read trick): INVALID_MEDIA', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const trap = await hlsPlaylistTrap(ff.dir, '/etc/passwd');
    const { result } = await run('LECTURE_VIDEO', await readFile(trap));
    expect(await failureCode(result)).toBe('INVALID_MEDIA');
  });

  it('ffprobe itself refuses HLS and concat inputs under the allowlists (defence in depth)', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const target = await clip720(ff.paths, ff.dir, 1);
    for (const trap of [await hlsPlaylistTrap(ff.dir, target), await concatTrap(ff.dir, target)]) {
      const error = await runProcess(ff.paths.ffprobe, buildProbeArgs('video', trap), {
        maxStdoutBytes: 65_536,
        timeoutMs: 30_000,
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ kind: 'exit' });
      expect((error as { details: { stderrTail: string } }).details.stderrTail).toMatch(
        /not on whitelist/,
      );
    }
  });

  it('declared duration beyond TRANSCODER_MAX_SOURCE_SECONDS: TOO_LONG before any encode', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const { storage, result } = await run(
      'LECTURE_VIDEO',
      await readFile(await declaredTooLong(ff.paths, ff.dir)),
    );
    expect(await failureCode(result)).toBe('TOO_LONG');
    expect(storage.keys('media')).toEqual([]);
  });

  it('a source larger than declared is INVALID_MEDIA (never downloaded past the declared size)', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const bytes = await readFile(await silentClip(ff.paths, ff.dir));
    const storage = new FakeStorage();
    const assetId = randomUUID();
    const sourceKey = `uploads/${OWNER}/${assetId}/source`;
    storage.put({ bucket: 'uploads', key: sourceKey }, bytes);
    const pipeline = new MediaPipeline(
      new FfmpegToolchain(ff.paths),
      storage.asObjectStorage(),
      SETTINGS,
    );
    const workDir = await mkdtemp(join(ff.dir, 'job-'));
    const result = pipeline.process({
      assetId,
      leaseNo: 1,
      purpose: 'LECTURE_VIDEO',
      sourceKey,
      declaredSizeBytes: bytes.length - 1,
      workDir,
      signal: new AbortController().signal,
      reportProgress: () => undefined,
    });
    expect(await failureCode(result)).toBe('INVALID_MEDIA');
  });

  it('abort (shutdown / lost lease) kills ffmpeg mid-encode and rejects with the reason', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const controller = new AbortController();
    const reason = new Error('lease lost');
    const source = await readFile(await clip720(ff.paths, ff.dir, 30));
    const started = Date.now();
    const { progress, result } = await run('LECTURE_VIDEO', source, { signal: controller.signal });
    const poll = setInterval(() => {
      if (progress.some((p) => p > 3)) controller.abort(reason);
    }, 20);
    try {
      await expect(result).rejects.toBe(reason);
    } finally {
      clearInterval(poll);
    }
    expect(Math.max(...progress)).toBeLessThan(85);
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});

describe('COURSE_THUMBNAIL', () => {
  it.for(['png', 'jpeg', 'webp'] as const)(
    '%s -> w750 / w480 / poster JPEGs without metadata',
    async (format, ctx) => {
      ff.skipIfUnavailable(ctx);
      const { storage, assetId, result } = await run(
        'COURSE_THUMBNAIL',
        await readFile(await stillImage(ff.paths, ff.dir, format)),
      );
      const out = await result;
      expect(out).toMatchObject({
        width: 1600,
        height: 1200,
        durationMs: null,
        detectedFormat: `${format}_pipe`,
      });
      expect(out.renditions.map((r) => `${r.name}=${r.width}x${r.height}:${r.kind}`)).toEqual([
        'w750=750x422:IMAGE',
        'w480=480x270:IMAGE',
        'poster=1280x720:IMAGE',
      ]);
      for (const rendition of out.renditions) {
        const object = storage.get({
          bucket: 'media',
          key: `assets/${assetId}/a1/${rendition.name}.jpg`,
        });
        expect(object?.contentType).toBe('image/jpeg');
        expect(object?.body.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
        const text = object?.body.toString('latin1') ?? '';
        expect(text).not.toContain('Exif');
        expect(text).not.toContain('Lavc');
        // the decoded size is what the rendition row claims
        const file = join(ff.dir, `${assetId}-${rendition.name}.jpg`);
        await writeFile(file, object?.body ?? Buffer.alloc(0));
        const { stdout } = await runProcess(
          ff.paths.ffprobe,
          ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
          { maxStdoutBytes: 1024, timeoutMs: 30_000 },
        );
        expect(stdout.trim()).toBe(`${rendition.width},${rendition.height}`);
      }
    },
  );

  it('decompression bomb header (65535x65535 PNG): TOO_LARGE_DIMENSIONS before decoding', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const { result } = await run(
      'COURSE_THUMBNAIL',
      Buffer.concat([pngHeader(65535, 65535), Buffer.alloc(64)]),
    );
    expect(await failureCode(result)).toBe('TOO_LARGE_DIMENSIONS');
  });

  it('GIF and video uploads are UNSUPPORTED_MEDIA', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    expect(await failureCode((await run('COURSE_THUMBNAIL', GIF_BYTES)).result)).toBe(
      'UNSUPPORTED_MEDIA',
    );
    const video = await readFile(await silentClip(ff.paths, ff.dir));
    expect(await failureCode((await run('COURSE_THUMBNAIL', video)).result)).toBe(
      'UNSUPPORTED_MEDIA',
    );
  });

  it('a PNG header with an undecodable body is INVALID_MEDIA', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const garbage = Buffer.alloc(1024);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 2654435761) >>> 24;
    const png = Buffer.concat([pngHeader(320, 240), Buffer.alloc(4), garbage]);
    expect(await failureCode((await run('COURSE_THUMBNAIL', png)).result)).toBe('INVALID_MEDIA');
  });
});

describe('LECTURE_RESOURCE', () => {
  it('PDF: copied as attachment + octet-stream, no renditions', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const { storage, assetId, result } = await run('LECTURE_RESOURCE', PDF_BYTES);
    expect(await result).toEqual({
      durationMs: null,
      width: null,
      height: null,
      detectedFormat: 'pdf',
      renditions: [],
    });
    expect(storage.get({ bucket: 'media', key: `assets/${assetId}/a1/resource` })).toEqual({
      body: PDF_BYTES,
      contentType: 'application/octet-stream',
      cacheControl: 'public, max-age=31536000, immutable',
      contentDisposition: 'attachment',
    });
  });

  it('an HTML file declared as PDF is INVALID_MEDIA; a video is UNSUPPORTED_MEDIA', async (ctx) => {
    ff.skipIfUnavailable(ctx);
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    expect(await failureCode((await run('LECTURE_RESOURCE', html)).result)).toBe('INVALID_MEDIA');
    const video = await readFile(await silentClip(ff.paths, ff.dir));
    expect(await failureCode((await run('LECTURE_RESOURCE', video)).result)).toBe(
      'UNSUPPORTED_MEDIA',
    );
  });
});
