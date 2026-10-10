import { type DisplaySize, MAX_OUTPUT_FPS, MIN_SOURCE_SHORT_SIDE } from '../ffmpeg/ladder';
import type { ProbeResult, ProbedVideoStream } from '../ffmpeg/probe';
import { IMAGE_MAX_PIXELS, isAllowedFormatName } from '../ffmpeg/whitelists';
import { TranscodeFailure } from './failure';
import type { ImageDimensions } from './magic-bytes';

/** Video frame limits (design §4: > 4096x2160 is TOO_LARGE_DIMENSIONS, either orientation). */
export const MAX_VIDEO_LONG_SIDE = 4096;
export const MAX_VIDEO_SHORT_SIDE = 2160;
/** Images: 40 MP (contracts) and no side above 16384. */
export const MAX_IMAGE_SIDE = 16_384;
export const MIN_IMAGE_SIDE = 16;

export interface VideoSource {
  readonly formatName: string;
  readonly durationSeconds: number;
  readonly durationMs: number;
  /** Size after sample-aspect and rotation correction (what the viewer sees). */
  readonly display: DisplaySize;
  readonly hasAudio: boolean;
  /** The source runs above 30 fps: the encode adds `fps=30`. */
  readonly capFrameRate: boolean;
}

function mainVideoStream(probe: ProbeResult): ProbedVideoStream | undefined {
  return probe.video.find((stream) => !stream.attachedPic);
}

function displaySize(stream: ProbedVideoStream): DisplaySize {
  const sar = stream.sampleAspectRatio;
  const width = sar === null ? stream.width : Math.round((stream.width * sar.num) / sar.den);
  const rotated = stream.rotation === 90 || stream.rotation === 270;
  return rotated ? { width: stream.height, height: width } : { width, height: stream.height };
}

function exceedsVideoLimits(size: DisplaySize): boolean {
  return (
    Math.max(size.width, size.height) > MAX_VIDEO_LONG_SIDE ||
    Math.min(size.width, size.height) > MAX_VIDEO_SHORT_SIDE
  );
}

/** Validates an ffprobe result for LECTURE_VIDEO; throws a poison TranscodeFailure otherwise. */
export function checkVideoProbe(
  probe: ProbeResult,
  limits: { maxSourceSeconds: number },
): VideoSource {
  if (!isAllowedFormatName('video', probe.formatName)) {
    throw new TranscodeFailure('UNSUPPORTED_MEDIA', `container ${probe.formatName} not allowed`);
  }
  const stream = mainVideoStream(probe);
  if (stream === undefined) throw new TranscodeFailure('INVALID_MEDIA', 'no video stream');
  if (stream.width <= 0 || stream.height <= 0) {
    throw new TranscodeFailure('INVALID_MEDIA', 'video stream has no frame size');
  }
  const coded = { width: stream.width, height: stream.height };
  const display = displaySize(stream);
  if (exceedsVideoLimits(coded) || exceedsVideoLimits(display)) {
    throw new TranscodeFailure(
      'TOO_LARGE_DIMENSIONS',
      `frame ${coded.width}x${coded.height} (display ${display.width}x${display.height}) exceeds ${MAX_VIDEO_LONG_SIDE}x${MAX_VIDEO_SHORT_SIDE}`,
    );
  }
  if (Math.min(display.width, display.height) < MIN_SOURCE_SHORT_SIDE) {
    throw new TranscodeFailure(
      'INVALID_MEDIA',
      `frame ${display.width}x${display.height} below ${MIN_SOURCE_SHORT_SIDE}px`,
    );
  }
  if (probe.durationSeconds === null) {
    throw new TranscodeFailure('INVALID_MEDIA', 'no or zero duration');
  }
  if (probe.durationSeconds > limits.maxSourceSeconds) {
    throw new TranscodeFailure(
      'TOO_LONG',
      `duration ${probe.durationSeconds}s > ${limits.maxSourceSeconds}s`,
    );
  }
  const durationMs = Math.max(1, Math.round(probe.durationSeconds * 1000));
  return {
    formatName: probe.formatName,
    durationSeconds: probe.durationSeconds,
    durationMs,
    display,
    hasAudio: probe.audio.length > 0,
    capFrameRate: stream.frameRate !== null && stream.frameRate > MAX_OUTPUT_FPS + 0.01,
  };
}

/**
 * Header dimensions of a thumbnail upload, checked BEFORE any decoder runs (pixel-count cap).
 */
export function checkImageHeader(dimensions: ImageDimensions | null): ImageDimensions {
  if (dimensions === null) throw new TranscodeFailure('INVALID_MEDIA', 'unreadable image header');
  const { width, height } = dimensions;
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > IMAGE_MAX_PIXELS) {
    throw new TranscodeFailure(
      'TOO_LARGE_DIMENSIONS',
      `image ${width}x${height} exceeds ${IMAGE_MAX_PIXELS} px / ${MAX_IMAGE_SIDE}px`,
    );
  }
  if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) {
    throw new TranscodeFailure('INVALID_MEDIA', `image ${width}x${height} too small`);
  }
  return dimensions;
}

export interface ImageSource {
  readonly formatName: string;
  readonly width: number;
  readonly height: number;
}

/** Validates an ffprobe result for COURSE_THUMBNAIL against the header dimensions. */
export function checkImageProbe(probe: ProbeResult, header: ImageDimensions): ImageSource {
  if (!isAllowedFormatName('image', probe.formatName)) {
    throw new TranscodeFailure('UNSUPPORTED_MEDIA', `image format ${probe.formatName} not allowed`);
  }
  const stream = probe.video[0];
  if (stream === undefined) throw new TranscodeFailure('INVALID_MEDIA', 'no image stream');
  if (stream.width <= 0 || stream.height <= 0) {
    throw new TranscodeFailure('INVALID_MEDIA', 'image could not be decoded');
  }
  if (stream.width !== header.width || stream.height !== header.height) {
    throw new TranscodeFailure(
      'INVALID_MEDIA',
      `decoded size ${stream.width}x${stream.height} differs from header ${header.width}x${header.height}`,
    );
  }
  return { formatName: probe.formatName, width: stream.width, height: stream.height };
}
