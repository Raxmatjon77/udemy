import { MEDIA_PURPOSE_RULES } from '@udemy/contracts';

/**
 * Hostile-input allowlists (design §9). Every ffprobe/ffmpeg run that reads a user upload passes
 * `-protocol_whitelist file` and a `-format_whitelist`, which blocks the HLS/concat/playlist
 * demuxers (and any network protocol) that turn a crafted upload into a local-file read or an
 * outbound request.
 */
export const PROTOCOL_WHITELIST = 'file';

/**
 * Video demuxers. `mov,mp4,m4a,3gp,3g2,mj2` is ONE demuxer (ISO BMFF / QuickTime), `matroska,webm`
 * another, then `avi`. A demuxer is allowed when any of its comma-separated names is listed.
 */
export const VIDEO_DEMUXERS = [
  'mov',
  'mp4',
  'm4a',
  '3gp',
  '3g2',
  'mj2',
  'matroska',
  'webm',
  'avi',
] as const;

/**
 * Image demuxers. The `*_pipe` demuxers detect by content. `image2` (extension-based, supports
 * sequence patterns and globbing) is deliberately absent; the source file has no extension.
 */
export const IMAGE_DEMUXERS = ['png_pipe', 'jpeg_pipe', 'webp_pipe'] as const;

export type ProbeProfile = 'video' | 'image';

export function demuxerWhitelist(profile: ProbeProfile): string {
  return (profile === 'video' ? VIDEO_DEMUXERS : IMAGE_DEMUXERS).join(',');
}

/** True when ffprobe's `format_name` (e.g. `matroska,webm`) names an allowed demuxer. */
export function isAllowedFormatName(profile: ProbeProfile, formatName: string): boolean {
  const allowed: readonly string[] = profile === 'video' ? VIDEO_DEMUXERS : IMAGE_DEMUXERS;
  return formatName.split(',').some((name) => allowed.includes(name.trim()));
}

/** Decoder pixel cap (`-max_pixels`): 4096x2160 for video (either orientation), 40 MP for images. */
export const VIDEO_MAX_PIXELS = 4096 * 2160;
export const IMAGE_MAX_PIXELS: number = MEDIA_PURPOSE_RULES.COURSE_THUMBNAIL.maxPixels;

export function maxPixelsFor(profile: ProbeProfile): number {
  return profile === 'video' ? VIDEO_MAX_PIXELS : IMAGE_MAX_PIXELS;
}

/**
 * The input options every hostile-input read starts with. `file:` makes the path explicit, so a
 * path can never be parsed as another protocol (our paths are generated, but be strict anyway).
 */
export function hardenedInput(
  profile: ProbeProfile,
  inputPath: string,
  extra: readonly string[] = [],
): string[] {
  if (!inputPath.startsWith('/')) throw new Error(`input path must be absolute: ${inputPath}`);
  return [
    '-protocol_whitelist',
    PROTOCOL_WHITELIST,
    '-format_whitelist',
    demuxerWhitelist(profile),
    '-max_pixels',
    String(maxPixelsFor(profile)),
    ...extra,
    '-i',
    `file:${inputPath}`,
  ];
}
