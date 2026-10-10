import { HLS_SEGMENT_FILENAME_PATTERN, HLS_VARIANT_PLAYLIST_FILENAME } from '@udemy/storage';
import { AUDIO_BITRATE_KBPS, type DisplaySize, MAX_OUTPUT_FPS, type Rendition } from './ladder';
import { hardenedInput } from './whitelists';

/**
 * ffmpeg argument builders. Arguments are assembled ONLY from allowlisted constants and numbers we
 * computed (sizes, bitrates, timestamps) plus paths we generated inside the per-attempt work dir.
 * Nothing user-controlled (filenames, metadata, declared types) ever reaches an argument, and
 * the vector goes to execve without a shell (see process.ts).
 */

export const HLS_SEGMENT_SECONDS = 6;
/** Forced keyframe interval: segments cut exactly every 6 s (and 2-s GOPs for seeking). */
export const KEYFRAME_INTERVAL_SECONDS = 2;
export const X264_PRESET = 'veryfast';
export const JPEG_QUALITY = 3;
export const SPRITE_JPEG_QUALITY = 5;

const COMMON = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error'];
/** No container/stream metadata or chapters (titles, GPS, encoder tags) is copied to outputs. */
const STRIP_METADATA = ['-map_metadata', '-1', '-map_chapters', '-1'];
/** No `Lavc`/`Lavf` version comment in JPEGs. */
const BITEXACT = ['-fflags', '+bitexact', '-flags:v', '+bitexact'];

function assertAbsolute(path: string): void {
  if (!path.startsWith('/') || path.includes('\0'))
    throw new Error(`not an absolute path: ${path}`);
}

function assertThreads(threads: number): void {
  if (!Number.isInteger(threads) || threads < 0 || threads > 64) {
    throw new RangeError(`threads must be an integer in 0..64, got ${threads}`);
  }
}

function assertSize(size: DisplaySize): void {
  for (const side of [size.width, size.height]) {
    if (!Number.isInteger(side) || side < 2 || side > 8192 || side % 2 !== 0) {
      throw new RangeError(`invalid output size ${size.width}x${size.height}`);
    }
  }
}

/** `-threads N` (0 = ffmpeg decides) for decoders/encoders, plus filter threads when capped. */
function threadArgs(threads: number): string[] {
  return ['-threads', String(threads)];
}

/** Seconds as ffmpeg time (`12.345`). */
export function ffmpegSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`invalid time ${seconds}`);
  return (Math.round(seconds * 1000) / 1000).toFixed(3);
}

/** `scale=...,setsar=1[,fps=30],format=...` for one output. */
function scaleChain(size: DisplaySize, opts: { fpsCap: boolean; pixFmt: string }): string {
  const parts = [`scale=w=${size.width}:h=${size.height}:flags=bicubic`, 'setsar=1'];
  if (opts.fpsCap) parts.push(`fps=${MAX_OUTPUT_FPS}`);
  parts.push(`format=${opts.pixFmt}`);
  return parts.join(',');
}

// ------------------------------------------------------------------------------------------- HLS

export interface HlsArgsInput {
  readonly inputPath: string;
  /** `{outputDir}/hls/{rendition}/index.m3u8` + `seg_%05d.ts` are written. */
  readonly outputDir: string;
  readonly renditions: readonly Rendition[];
  readonly hasAudio: boolean;
  /** Source frame rate > 30: add `fps=30`. */
  readonly capFrameRate: boolean;
  readonly threads: number;
  /** Hard stop for the output duration (TRANSCODER_MAX_SOURCE_SECONDS). */
  readonly maxOutputSeconds: number;
}

/**
 * One ffmpeg run for the whole ladder: decode once, `split` to one scaler per rendition, one
 * x264 encoder each, HLS v3 with 6-s MPEG-TS segments (D15). Progress goes to stdout.
 */
export function buildHlsArgs(input: HlsArgsInput): string[] {
  assertAbsolute(input.inputPath);
  assertAbsolute(input.outputDir);
  assertThreads(input.threads);
  if (input.renditions.length === 0) throw new RangeError('no renditions');
  input.renditions.forEach(assertSize);
  if (!Number.isInteger(input.maxOutputSeconds) || input.maxOutputSeconds < 1) {
    throw new RangeError('maxOutputSeconds must be a positive integer');
  }

  const n = input.renditions.length;
  const splitLabels = input.renditions.map((_, i) => `[s${i}]`).join('');
  const chains = input.renditions.map(
    (r, i) => `[s${i}]${scaleChain(r, { fpsCap: input.capFrameRate, pixFmt: 'yuv420p' })}[v${i}]`,
  );
  const graph = [`[0:v:0]split=${n}${splitLabels}`, ...chains].join(';');

  const maps = input.renditions.flatMap((_, i) => [
    '-map',
    `[v${i}]`,
    ...(input.hasAudio ? ['-map', '0:a:0'] : []),
  ]);
  const perRendition = input.renditions.flatMap((r, i) => [
    `-profile:v:${i}`,
    r.profile,
    `-level:v:${i}`,
    r.level,
    `-b:v:${i}`,
    `${r.videoKbps}k`,
    `-maxrate:v:${i}`,
    `${r.maxrateKbps}k`,
    `-bufsize:v:${i}`,
    `${r.bufsizeKbps}k`,
  ]);
  const audio = input.hasAudio
    ? ['-c:a', 'aac', '-b:a', `${AUDIO_BITRATE_KBPS}k`, '-ac', '2', '-ar', '48000']
    : [];
  const streamMap = input.renditions
    .map((r, i) => (input.hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`))
    .join(' ');
  const hlsDir = `${input.outputDir}/hls/%v`;

  return [
    ...COMMON,
    ...threadArgs(input.threads),
    ...hardenedInput('video', input.inputPath),
    '-filter_complex',
    graph,
    ...(input.threads > 0 ? ['-filter_complex_threads', String(input.threads)] : []),
    ...maps,
    '-c:v',
    'libx264',
    '-preset',
    X264_PRESET,
    ...threadArgs(input.threads),
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${KEYFRAME_INTERVAL_SECONDS})`,
    ...perRendition,
    ...audio,
    ...STRIP_METADATA,
    '-t',
    String(input.maxOutputSeconds),
    '-f',
    'hls',
    '-hls_time',
    String(HLS_SEGMENT_SECONDS),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'mpegts',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    `${hlsDir}/${HLS_SEGMENT_FILENAME_PATTERN}`,
    '-var_stream_map',
    streamMap,
    '-progress',
    'pipe:1',
    '-y',
    `${hlsDir}/${HLS_VARIANT_PLAYLIST_FILENAME}`,
  ];
}

// ---------------------------------------------------------------------------------------- poster

export interface FrameArgsInput {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly size: DisplaySize;
  /** Seek position in seconds (input seeking). */
  readonly atSeconds: number;
  readonly threads: number;
}

/** A single JPEG frame (video poster), metadata stripped. */
export function buildPosterArgs(input: FrameArgsInput): string[] {
  assertAbsolute(input.inputPath);
  assertAbsolute(input.outputPath);
  assertThreads(input.threads);
  assertSize(input.size);
  return [
    ...COMMON,
    ...threadArgs(input.threads),
    ...hardenedInput('video', input.inputPath, ['-ss', ffmpegSeconds(input.atSeconds)]),
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    scaleChain(input.size, { fpsCap: false, pixFmt: 'yuvj420p' }),
    ...STRIP_METADATA,
    ...BITEXACT,
    '-c:v',
    'mjpeg',
    '-q:v',
    String(JPEG_QUALITY),
    ...threadArgs(input.threads),
    '-f',
    'image2',
    '-update',
    '1',
    '-y',
    input.outputPath,
  ];
}

// ---------------------------------------------------------------------------------------- sprite

export interface SpriteArgsInput {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly tile: DisplaySize;
  readonly columns: number;
  readonly rows: number;
  readonly intervalSeconds: number;
  readonly threads: number;
}

/** The first frame, then one every `intervalSeconds`, tiled into a `columns x rows` JPEG sheet. */
export function buildSpriteArgs(input: SpriteArgsInput): string[] {
  assertAbsolute(input.inputPath);
  assertAbsolute(input.outputPath);
  assertThreads(input.threads);
  assertSize(input.tile);
  for (const [name, value] of [
    ['columns', input.columns],
    ['rows', input.rows],
    ['intervalSeconds', input.intervalSeconds],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 10_000) {
      throw new RangeError(`${name} must be a positive integer, got ${value}`);
    }
  }
  // `select` keeps the first frame and then one every `interval` s. (`fps=1/N` emits nothing for
  // clips shorter than N/2 and rounds the tile count.) `\,` escapes the comma inside the filter.
  const filter = [
    `select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,${input.intervalSeconds})`,
    `scale=w=${input.tile.width}:h=${input.tile.height}:flags=bicubic`,
    'setsar=1',
    `tile=${input.columns}x${input.rows}`,
    'format=yuvj420p',
  ].join(',');
  return [
    ...COMMON,
    ...threadArgs(input.threads),
    ...hardenedInput('video', input.inputPath),
    '-map',
    '0:v:0',
    '-vf',
    filter,
    '-frames:v',
    '1',
    ...STRIP_METADATA,
    ...BITEXACT,
    '-c:v',
    'mjpeg',
    '-q:v',
    String(SPRITE_JPEG_QUALITY),
    ...threadArgs(input.threads),
    '-f',
    'image2',
    '-update',
    '1',
    '-y',
    input.outputPath,
  ];
}

// ---------------------------------------------------------------------------------------- images

export interface ImageVariantOutput {
  readonly outputPath: string;
  readonly size: DisplaySize;
}

export interface ImageArgsInput {
  readonly inputPath: string;
  readonly outputs: readonly ImageVariantOutput[];
  readonly threads: number;
}

/**
 * Course thumbnails: decode the image once, then for each variant scale to COVER the target box
 * and centre-crop to it (16:9), re-encode as baseline JPEG with no metadata (EXIF/XMP/ICC
 * comments are never copied; D11).
 */
export function buildImageArgs(input: ImageArgsInput): string[] {
  assertAbsolute(input.inputPath);
  assertThreads(input.threads);
  if (input.outputs.length === 0) throw new RangeError('no image outputs');
  const n = input.outputs.length;
  const split = `[0:v:0]split=${n}${input.outputs.map((_, i) => `[s${i}]`).join('')}`;
  const chains = input.outputs.map(({ size }, i) => {
    assertSize(size);
    return (
      `[s${i}]scale=w=${size.width}:h=${size.height}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=w=${size.width}:h=${size.height},setsar=1,format=yuvj420p[o${i}]`
    );
  });
  const outputs = input.outputs.flatMap(({ outputPath }, i) => {
    assertAbsolute(outputPath);
    return [
      '-map',
      `[o${i}]`,
      '-frames:v',
      '1',
      ...STRIP_METADATA,
      ...BITEXACT,
      '-c:v',
      'mjpeg',
      '-q:v',
      String(JPEG_QUALITY),
      '-f',
      'image2',
      '-update',
      '1',
      '-y',
      outputPath,
    ];
  });
  return [
    ...COMMON,
    ...threadArgs(input.threads),
    ...hardenedInput('image', input.inputPath),
    '-filter_complex',
    [split, ...chains].join(';'),
    ...(input.threads > 0 ? ['-filter_complex_threads', String(input.threads)] : []),
    ...outputs,
  ];
}
