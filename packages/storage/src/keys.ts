import { StorageUsageError } from './errors';

/**
 * The object-key layout shared by the api (media), the transcoder and the worker. It is the ONLY
 * place keys are built; nothing derives a key from user input (filenames are display-only).
 *
 * udemy-uploads (quarantine, never presigned for GET):
 *   uploads/{ownerId}/{assetId}/source                       raw upload (design §4 `sourceKey`)
 *
 * udemy-media (served through presigned GETs only):
 *   assets/{assetId}/                                        everything for one asset (purge)
 *   assets/{assetId}/a{outputVersion}/                       one transcode output (`output_prefix`)
 *     hls/{rendition}/index.m3u8                             HLS v3 variant playlist (D15)
 *     hls/{rendition}/seg_00000.ts                           6 s MPEG-TS segments
 *     {w750|w480|poster}.jpg                                 re-encoded images
 *     sprite.jpg, sprite.vtt                                 scrubbing sprite + WebVTT
 *     resource                                               copied LECTURE_RESOURCE bytes
 *
 * `outputVersion` is the transcode attempt number (`a{attempt}`), so a retry never overwrites a
 * previous attempt's objects and every output is immutable (the API caches playlists per key).
 * There is no stored master playlist: the API renders it from `media.asset_renditions` (D7).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const UPLOADS_PREFIX = 'uploads/';
export const ASSETS_PREFIX = 'assets/';
export const SOURCE_OBJECT_NAME = 'source';

/** ffmpeg `-hls_segment_filename` basename, relative to the variant playlist's directory. */
export const HLS_SEGMENT_FILENAME_PATTERN = 'seg_%05d.ts';
export const HLS_VARIANT_PLAYLIST_FILENAME = 'index.m3u8';

/** Same set as the `media.asset_renditions.name` CHECK (design §6). */
export const RENDITION_NAME_PATTERN =
  /^(360p|480p|720p|1080p|src\d{3,4}p|w750|w480|poster|sprite)$/;
const HLS_RENDITION_PATTERN = /^(360p|480p|720p|1080p|src\d{3,4}p)$/;

export type ImageVariant = 'w750' | 'w480' | 'poster';
const IMAGE_VARIANTS: ReadonlySet<string> = new Set<ImageVariant>(['w750', 'w480', 'poster']);

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) {
    throw new StorageUsageError(`${name} must be a lowercase UUID (got "${value}")`);
  }
}

function assertOutputVersion(outputVersion: number): void {
  if (!Number.isInteger(outputVersion) || outputVersion < 1 || outputVersion > 1_000_000) {
    throw new StorageUsageError(`outputVersion must be a positive integer (got ${outputVersion})`);
  }
}

/** `uploads/{ownerId}/{assetId}/source` */
export function uploadSourceKey(ownerId: string, assetId: string): string {
  assertUuid(ownerId, 'ownerId');
  assertUuid(assetId, 'assetId');
  return `${UPLOADS_PREFIX}${ownerId}/${assetId}/${SOURCE_OBJECT_NAME}`;
}

/**
 * Inverse of `uploadSourceKey`; `null` for anything else. The janitor uses it to match
 * `ListMultipartUploads(uploads/)` entries to assets (design §5, MediaCleanupJob B).
 */
export function parseUploadSourceKey(key: string): { ownerId: string; assetId: string } | null {
  const match =
    /^uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/source$/.exec(
      key,
    );
  if (match === null) return null;
  return { ownerId: match[1] as string, assetId: match[2] as string };
}

/** `assets/{assetId}/`: every output version of one asset (purge deletes this prefix). */
export function assetPrefix(assetId: string): string {
  assertUuid(assetId, 'assetId');
  return `${ASSETS_PREFIX}${assetId}/`;
}

/** `assets/{assetId}/a{outputVersion}/`: stored as `media.assets.output_prefix`. */
export function assetOutputPrefix(assetId: string, outputVersion: number): string {
  assertOutputVersion(outputVersion);
  return `${assetPrefix(assetId)}a${outputVersion}/`;
}

/** Inverse of `assetOutputPrefix`; `null` for anything else. */
export function parseAssetOutputPrefix(
  prefix: string,
): { assetId: string; outputVersion: number } | null {
  const match =
    /^assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/a([1-9]\d{0,6})\/$/.exec(
      prefix,
    );
  if (match === null) return null;
  const outputVersion = Number(match[2]);
  if (outputVersion > 1_000_000) return null;
  return { assetId: match[1] as string, outputVersion };
}

function assertOutputPrefix(outputPrefix: string): void {
  if (parseAssetOutputPrefix(outputPrefix) === null) {
    throw new StorageUsageError(`"${outputPrefix}" is not an asset output prefix`);
  }
}

/** Throws unless `name` is an allowed rendition name (no path injection into keys). */
export function assertRenditionName(name: string): void {
  if (!RENDITION_NAME_PATTERN.test(name)) {
    throw new StorageUsageError(`"${name}" is not a valid rendition name`);
  }
}

/** Directory of one HLS variant: `{outputPrefix}hls/{rendition}/`. */
export function hlsVariantPrefix(outputPrefix: string, rendition: string): string {
  assertOutputPrefix(outputPrefix);
  if (!HLS_RENDITION_PATTERN.test(rendition)) {
    throw new StorageUsageError(`"${rendition}" is not an HLS rendition name`);
  }
  return `${outputPrefix}hls/${rendition}/`;
}

/** `{outputPrefix}hls/{rendition}/index.m3u8` */
export function hlsVariantPlaylistKey(outputPrefix: string, rendition: string): string {
  return `${hlsVariantPrefix(outputPrefix, rendition)}${HLS_VARIANT_PLAYLIST_FILENAME}`;
}

/** `{outputPrefix}hls/{rendition}/seg_00042.ts` (0-based, as ffmpeg numbers them). */
export function hlsSegmentKey(outputPrefix: string, rendition: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 99_999) {
    throw new StorageUsageError(`segment index ${index} is outside [0, 99999]`);
  }
  return `${hlsVariantPrefix(outputPrefix, rendition)}seg_${String(index).padStart(5, '0')}.ts`;
}

/** `{outputPrefix}{w750|w480|poster}.jpg` */
export function imageKey(outputPrefix: string, variant: ImageVariant): string {
  assertOutputPrefix(outputPrefix);
  if (!IMAGE_VARIANTS.has(variant)) {
    throw new StorageUsageError(`"${String(variant)}" is not an image variant`);
  }
  return `${outputPrefix}${variant}.jpg`;
}

/** `{outputPrefix}sprite.jpg` */
export function spriteImageKey(outputPrefix: string): string {
  assertOutputPrefix(outputPrefix);
  return `${outputPrefix}sprite.jpg`;
}

/** `{outputPrefix}sprite.vtt` */
export function spriteVttKey(outputPrefix: string): string {
  assertOutputPrefix(outputPrefix);
  return `${outputPrefix}sprite.vtt`;
}

/** `{outputPrefix}resource`: a LECTURE_RESOURCE, served only as attachment + octet-stream (D11). */
export function resourceKey(outputPrefix: string): string {
  assertOutputPrefix(outputPrefix);
  return `${outputPrefix}resource`;
}

const RELATIVE_URI = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

/**
 * Resolves a URI line of a stored variant playlist (e.g. `seg_00003.ts`) to the object key the
 * playlist rewriter presigns (D7). Only plain relative paths below the playlist's directory are
 * accepted: no scheme, no leading `/`, no `.`/`..` segments, no query or fragment. Our ffmpeg
 * output only ever contains such lines, so anything else means a tampered or foreign playlist.
 */
export function resolvePlaylistUri(playlistKey: string, uri: string): string {
  const slash = playlistKey.lastIndexOf('/');
  if (slash <= 0) throw new StorageUsageError(`"${playlistKey}" has no directory`);
  if (!RELATIVE_URI.test(uri)) {
    throw new StorageUsageError(`playlist URI "${uri}" is not a plain relative path`);
  }
  return `${playlistKey.slice(0, slash + 1)}${uri}`;
}
