import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { MEDIA_PURPOSE_RULES, type MediaPurpose } from '@udemy/contracts';
import type { RenditionInput } from '@udemy/db';
import {
  assetOutputPrefix,
  HLS_VARIANT_PLAYLIST_FILENAME,
  imageKey,
  type ImageVariant,
  ObjectStorage,
  resourceKey,
  spriteImageKey,
  spriteVttKey,
} from '@udemy/storage';
import { buildHlsArgs, buildImageArgs, buildPosterArgs, buildSpriteArgs } from '../ffmpeg/args';
import { FfmpegToolchain } from '../ffmpeg/ffmpeg-toolchain.service';
import { type Rendition, renditionCodecs, selectLadder } from '../ffmpeg/ladder';
import { ProcessError } from '../ffmpeg/process';
import {
  buildProbeArgs,
  parseProbeOutput,
  PROBE_MAX_OUTPUT_BYTES,
  ProbeParseError,
  type ProbeResult,
} from '../ffmpeg/probe';
import { FfmpegProgressParser, progressPercent } from '../ffmpeg/progress';
import type { ProbeProfile } from '../ffmpeg/whitelists';
import { TranscodeFailure } from './failure';
import {
  checkMagic,
  type DetectedType,
  IMAGE_HEADER_BYTES,
  MAGIC_HEAD_BYTES,
  readImageDimensions,
} from './magic-bytes';
import {
  collectHlsVariant,
  CONTENT_TYPES,
  IMMUTABLE_CACHE_CONTROL,
  RESOURCE_CONTENT_DISPOSITION,
  type UploadItem,
  uploadAll,
} from './outputs';
import {
  checkImageHeader,
  checkImageProbe,
  checkVideoProbe,
  type VideoSource,
} from './probe-checks';
import {
  downloadSource,
  ensureFreeSpace,
  FREE_SPACE_FACTOR,
  headSource,
  readHead,
  type SourceObject,
} from './source';
import { buildSpriteVtt, planSprite, SPRITE_IMAGE_FILENAME } from './sprite';

/** Tunables of the pipeline (from TRANSCODER_* plus fixed safety limits). */
export interface PipelineSettings {
  /** ffmpeg `-threads` (0 = auto). */
  readonly threads: number;
  /** Highest rung (short side), TRANSCODER_MAX_HEIGHT. */
  readonly maxShortSide: number;
  readonly timeoutFactor: number;
  readonly maxSourceSeconds: number;
  readonly spritesEnabled: boolean;
  /** Kill ffmpeg after this long without progress (TIMEOUT). Design: 120 s. */
  readonly stallTimeoutMs: number;
  /** SIGTERM -> SIGKILL grace. */
  readonly killGraceMs: number;
  /** Lower bound of the wall-clock budget (design: 300 s). */
  readonly minTimeoutMs: number;
}

export const PIPELINE_SETTINGS = Symbol.for('udemy.transcoder.PIPELINE_SETTINGS');

export interface PipelineJob {
  readonly assetId: string;
  /** Fencing token = output version `a{leaseNo}`. */
  readonly leaseNo: number;
  readonly purpose: MediaPurpose;
  readonly sourceKey: string;
  readonly declaredSizeBytes: number;
  /** Per-attempt scratch dir (created and removed by the caller). */
  readonly workDir: string;
  /** Aborted on shutdown or lease loss: running ffmpeg is killed, the promise rejects. */
  readonly signal: AbortSignal;
  /** 0..99, reported into the heartbeat. */
  readonly reportProgress: (pct: number) => void;
}

export interface PipelineResult {
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly detectedFormat: string | null;
  readonly renditions: RenditionInput[];
}

const PROBE_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 120_000;
const SOURCE_FILENAME = 'source';
/** Fraction of the progress bar used by the HLS encode; the rest is poster/sprite/upload. */
const ENCODE_SHARE = 0.85;

/** Course thumbnail variants (design §4: 16:9 JPEGs). */
export const THUMBNAIL_VARIANTS: readonly { name: ImageVariant; width: number; height: number }[] =
  [
    { name: 'w750', width: 750, height: 422 },
    { name: 'w480', width: 480, height: 270 },
    { name: 'poster', width: 1280, height: 720 },
  ];

/** Runs one job's media work: probe, encode, upload. Never touches the database. */
@Injectable()
export class MediaPipeline {
  constructor(
    private readonly toolchain: FfmpegToolchain,
    @Inject(ObjectStorage) private readonly storage: ObjectStorage,
    @Inject(PIPELINE_SETTINGS) private readonly settings: PipelineSettings,
  ) {}

  process(job: PipelineJob): Promise<PipelineResult> {
    switch (job.purpose) {
      case 'LECTURE_VIDEO':
        return this.processVideo(job);
      case 'COURSE_THUMBNAIL':
        return this.processImage(job);
      case 'LECTURE_RESOURCE':
        return this.processResource(job);
    }
  }

  // ------------------------------------------------------------------------------------ video

  private async processVideo(job: PipelineJob): Promise<PipelineResult> {
    const sourcePath = join(job.workDir, SOURCE_FILENAME);
    await this.fetchSource(job, sourcePath);
    const probe = await this.probe('video', sourcePath, job.signal);
    const video = checkVideoProbe(probe, { maxSourceSeconds: this.settings.maxSourceSeconds });
    const ladder = selectLadder(video.display, this.settings.maxShortSide);
    const deadline =
      Date.now() +
      Math.max(
        this.settings.minTimeoutMs,
        video.durationSeconds * 1000 * this.settings.timeoutFactor,
      );

    const outDir = join(job.workDir, 'out');
    for (const rendition of ladder) {
      await mkdir(join(outDir, 'hls', rendition.name), { recursive: true });
    }
    await this.encodeHls(job, sourcePath, outDir, ladder, video, deadline);

    const prefix = assetOutputPrefix(job.assetId, job.leaseNo);
    const uploads: UploadItem[] = [];
    const renditions: RenditionInput[] = [];
    for (const rendition of ladder) {
      const dir = join(outDir, 'hls', rendition.name);
      const playlist = await readFile(join(dir, HLS_VARIANT_PLAYLIST_FILENAME), 'utf8');
      const variant = await collectHlsVariant(dir, prefix, rendition.name, playlist);
      uploads.push(...variant.uploads);
      renditions.push({
        name: rendition.name,
        kind: 'HLS_VARIANT',
        width: rendition.width,
        height: rendition.height,
        bandwidthBps: variant.bandwidthBps,
        codecs: renditionCodecs(rendition, video.hasAudio),
        objectKey: variant.playlistKey,
      });
    }

    const top = ladder[ladder.length - 1] as Rendition;
    const posterPath = join(outDir, 'poster.jpg');
    await this.renderPoster(job, sourcePath, posterPath, top, video, deadline);
    uploads.push({
      filePath: posterPath,
      key: imageKey(prefix, 'poster'),
      contentType: CONTENT_TYPES.jpeg,
    });
    renditions.push({
      name: 'poster',
      kind: 'IMAGE',
      width: top.width,
      height: top.height,
      bandwidthBps: null,
      codecs: null,
      objectKey: imageKey(prefix, 'poster'),
    });
    job.reportProgress(Math.round(ENCODE_SHARE * 100) + 2);

    if (this.settings.spritesEnabled) {
      const plan = planSprite(video.durationSeconds, video.display);
      const spritePath = join(outDir, SPRITE_IMAGE_FILENAME);
      const vttPath = join(outDir, 'sprite.vtt');
      await this.toolchain.run(
        'ffmpeg',
        buildSpriteArgs({
          inputPath: sourcePath,
          outputPath: spritePath,
          tile: plan.tile,
          columns: plan.columns,
          rows: plan.rows,
          intervalSeconds: plan.intervalSeconds,
          threads: this.settings.threads,
        }),
        this.processOptions(job.signal, deadline),
      );
      await writeFile(vttPath, buildSpriteVtt(plan, video.durationSeconds), { mode: 0o600 });
      uploads.push(
        { filePath: spritePath, key: spriteImageKey(prefix), contentType: CONTENT_TYPES.jpeg },
        { filePath: vttPath, key: spriteVttKey(prefix), contentType: CONTENT_TYPES.vtt },
      );
      renditions.push({
        name: 'sprite',
        kind: 'SPRITE',
        width: plan.tile.width,
        height: plan.tile.height,
        bandwidthBps: null,
        codecs: null,
        objectKey: spriteVttKey(prefix),
      });
    }
    job.reportProgress(90);

    await uploadAll(this.storage, uploads, job.signal, (done, total) =>
      job.reportProgress(90 + Math.floor((9 * done) / total)),
    );
    return {
      durationMs: video.durationMs,
      width: video.display.width,
      height: video.display.height,
      detectedFormat: probe.formatName,
      renditions,
    };
  }

  private async encodeHls(
    job: PipelineJob,
    sourcePath: string,
    outDir: string,
    ladder: readonly Rendition[],
    video: VideoSource,
    deadline: number,
  ): Promise<void> {
    const parser = new FfmpegProgressParser();
    let lastOutTimeUs = -1;
    await this.toolchain.run(
      'ffmpeg',
      buildHlsArgs({
        inputPath: sourcePath,
        outputDir: outDir,
        renditions: ladder,
        hasAudio: video.hasAudio,
        capFrameRate: video.capFrameRate,
        threads: this.settings.threads,
        maxOutputSeconds: this.settings.maxSourceSeconds,
      }),
      {
        ...this.processOptions(job.signal, deadline),
        stallTimeoutMs: this.settings.stallTimeoutMs,
        onStdoutLine: (line) => {
          const snapshot = parser.push(line);
          if (snapshot === null || snapshot.outTimeUs === null) return false;
          job.reportProgress(
            Math.floor(progressPercent(snapshot.outTimeUs, video.durationMs) * ENCODE_SHARE),
          );
          const advanced = snapshot.outTimeUs > lastOutTimeUs;
          lastOutTimeUs = Math.max(lastOutTimeUs, snapshot.outTimeUs);
          return advanced;
        },
      },
    );
  }

  /** Poster at 10% of the duration; falls back to the first frame (e.g. a lying duration). */
  private async renderPoster(
    job: PipelineJob,
    sourcePath: string,
    posterPath: string,
    size: Rendition,
    video: VideoSource,
    deadline: number,
  ): Promise<void> {
    const render = (atSeconds: number): Promise<unknown> =>
      this.toolchain.run(
        'ffmpeg',
        buildPosterArgs({
          inputPath: sourcePath,
          outputPath: posterPath,
          size,
          atSeconds,
          threads: this.settings.threads,
        }),
        this.processOptions(job.signal, deadline),
      );
    try {
      await render(video.durationSeconds * 0.1);
    } catch (error) {
      if (!(error instanceof ProcessError) || error.kind !== 'exit') throw error;
      await render(0);
    }
  }

  // ----------------------------------------------------------------------------------- images

  private async processImage(job: PipelineJob): Promise<PipelineResult> {
    const sourcePath = join(job.workDir, SOURCE_FILENAME);
    const type = await this.fetchSource(job, sourcePath);
    const header = checkImageHeader(
      readImageDimensions(type, await readHead(sourcePath, IMAGE_HEADER_BYTES)),
    );
    const probe = await this.probe('image', sourcePath, job.signal);
    const image = checkImageProbe(probe, header);
    job.reportProgress(20);

    const outDir = join(job.workDir, 'out');
    await mkdir(outDir, { recursive: true });
    const prefix = assetOutputPrefix(job.assetId, job.leaseNo);
    const outputs = THUMBNAIL_VARIANTS.map((variant) => ({
      ...variant,
      outputPath: join(outDir, `${variant.name}.jpg`),
      key: imageKey(prefix, variant.name),
    }));
    await this.toolchain.run(
      'ffmpeg',
      buildImageArgs({
        inputPath: sourcePath,
        outputs: outputs.map((o) => ({
          outputPath: o.outputPath,
          size: { width: o.width, height: o.height },
        })),
        threads: this.settings.threads,
      }),
      this.processOptions(job.signal, Date.now() + IMAGE_TIMEOUT_MS),
    );
    job.reportProgress(80);
    await uploadAll(
      this.storage,
      outputs.map((o) => ({ filePath: o.outputPath, key: o.key, contentType: CONTENT_TYPES.jpeg })),
      job.signal,
    );
    return {
      durationMs: null,
      width: image.width,
      height: image.height,
      detectedFormat: image.formatName,
      renditions: outputs.map((o) => ({
        name: o.name,
        kind: 'IMAGE' as const,
        width: o.width,
        height: o.height,
        bandwidthBps: null,
        codecs: null,
        objectKey: o.key,
      })),
    };
  }

  // -------------------------------------------------------------------------------- resources

  /**
   * LECTURE_RESOURCE (D11): magic-byte check on the first bytes, then a server-side copy into the
   * media bucket as `application/octet-stream` + `attachment`. ZIPs are never opened.
   */
  private async processResource(job: PipelineJob): Promise<PipelineResult> {
    const source = await this.headSource(job);
    const head = await this.storage.getObjectRange({
      bucket: 'uploads',
      key: source.key,
      start: 0,
      end: Math.min(MAGIC_HEAD_BYTES, source.size),
    });
    const type = this.assertMagic(job.purpose, head);
    job.signal.throwIfAborted();
    await this.storage.copyObject({
      from: { bucket: 'uploads', key: source.key },
      to: { bucket: 'media', key: resourceKey(assetOutputPrefix(job.assetId, job.leaseNo)) },
      write: {
        contentType: CONTENT_TYPES.resource,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        contentDisposition: RESOURCE_CONTENT_DISPOSITION,
      },
    });
    return { durationMs: null, width: null, height: null, detectedFormat: type, renditions: [] };
  }

  // ---------------------------------------------------------------------------------- helpers

  private headSource(job: PipelineJob): Promise<SourceObject> {
    return headSource(this.storage, job.sourceKey, {
      declaredBytes: job.declaredSizeBytes,
      maxBytes: MEDIA_PURPOSE_RULES[job.purpose].maxBytes,
    });
  }

  /** HEAD + free-space check + streamed download + magic bytes. Returns the detected type. */
  private async fetchSource(job: PipelineJob, sourcePath: string): Promise<DetectedType> {
    const source = await this.headSource(job);
    await ensureFreeSpace(job.workDir, source.size * FREE_SPACE_FACTOR);
    await downloadSource(this.storage, source, sourcePath, job.signal);
    job.reportProgress(2);
    return this.assertMagic(job.purpose, await readHead(sourcePath, MAGIC_HEAD_BYTES));
  }

  private assertMagic(purpose: MediaPurpose, head: Buffer): DetectedType {
    const verdict = checkMagic(purpose, head);
    if (!verdict.ok) {
      throw new TranscodeFailure(verdict.code, `magic bytes: ${verdict.type} is not a ${purpose}`);
    }
    return verdict.type;
  }

  /** ffprobe with the allowlists; any refusal to read the file is poison. */
  private async probe(
    profile: ProbeProfile,
    path: string,
    signal: AbortSignal,
  ): Promise<ProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await this.toolchain.run('ffprobe', buildProbeArgs(profile, path), {
        signal,
        timeoutMs: PROBE_TIMEOUT_MS,
        killGraceMs: this.settings.killGraceMs,
        maxStdoutBytes: PROBE_MAX_OUTPUT_BYTES,
      }));
    } catch (error) {
      if (!(error instanceof ProcessError) || error.kind === 'spawn') throw error;
      const stderr = error.details.stderrTail;
      const code = /not on whitelist/i.test(stderr) ? 'UNSUPPORTED_MEDIA' : 'INVALID_MEDIA';
      throw new TranscodeFailure(code, `ffprobe: ${error.message}: ${stderr.trim()}`, false, {
        cause: error,
      });
    }
    try {
      return parseProbeOutput(stdout);
    } catch (error) {
      if (error instanceof ProbeParseError)
        throw new TranscodeFailure('INVALID_MEDIA', error.message);
      throw error;
    }
  }

  private processOptions(
    signal: AbortSignal,
    deadline: number,
  ): { signal: AbortSignal; timeoutMs: number; killGraceMs: number } {
    return {
      signal,
      timeoutMs: Math.max(1_000, deadline - Date.now()),
      killGraceMs: this.settings.killGraceMs,
    };
  }
}
