import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObjectStorage } from '@udemy/storage';
import {
  HLS_VARIANT_PLAYLIST_FILENAME,
  hlsSegmentKey,
  hlsVariantPlaylistKey,
} from '@udemy/storage';
import { TranscodeFailure } from './failure';

/** Every output is immutable per `a{n}/` prefix (design D7, §14). */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const CONTENT_TYPES = {
  playlist: 'application/vnd.apple.mpegurl',
  segment: 'video/mp2t',
  jpeg: 'image/jpeg',
  vtt: 'text/vtt; charset=utf-8',
  /** LECTURE_RESOURCE bytes are never served inline (D11). */
  resource: 'application/octet-stream',
} as const;

export const RESOURCE_CONTENT_DISPOSITION = 'attachment';

export interface UploadItem {
  readonly filePath: string;
  readonly key: string;
  readonly contentType: string;
  readonly contentDisposition?: string;
}

const UPLOAD_CONCURRENCY = 4;

/** Uploads to the media bucket, a few at a time; stops at the first error or on abort. */
export async function uploadAll(
  storage: ObjectStorage,
  items: readonly UploadItem[],
  signal: AbortSignal,
  onUploaded?: (done: number, total: number) => void,
): Promise<void> {
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      signal.throwIfAborted();
      const item = items[next++] as UploadItem;
      await storage.putFile({
        bucket: 'media',
        key: item.key,
        filePath: item.filePath,
        contentType: item.contentType,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        ...(item.contentDisposition === undefined
          ? {}
          : { contentDisposition: item.contentDisposition }),
      });
      done += 1;
      onUploaded?.(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, items.length) }, worker));
  signal.throwIfAborted();
}

// ------------------------------------------------------------------------------ HLS playlists

export interface PlaylistSegment {
  readonly uri: string;
  readonly index: number;
  readonly durationSeconds: number;
}

const SEGMENT_URI = /^seg_(\d{5})\.ts$/;
const EXTINF = /^#EXTINF:(\d+(?:\.\d+)?),/;

/**
 * Parses and validates an ffmpeg variant playlist before it is published: HLS v3, VOD, ended,
 * and every URI a plain `seg_NNNNN.ts` in order (the API's rewriter presigns exactly those, D7).
 */
export function parseVariantPlaylist(text: string): PlaylistSegment[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const fail = (why: string): never => {
    throw new TranscodeFailure('TRANSCODE_ERROR', `invalid variant playlist: ${why}`);
  };
  if (lines[0] !== '#EXTM3U') fail('missing #EXTM3U');
  if (!lines.includes('#EXT-X-VERSION:3')) fail('not HLS version 3');
  if (!lines.includes('#EXT-X-PLAYLIST-TYPE:VOD')) fail('not a VOD playlist');
  if (lines[lines.length - 1] !== '#EXT-X-ENDLIST') fail('missing #EXT-X-ENDLIST');

  const segments: PlaylistSegment[] = [];
  let pendingDuration: number | null = null;
  for (const line of lines) {
    const inf = EXTINF.exec(line);
    if (inf !== null) {
      pendingDuration = Number(inf[1]);
      continue;
    }
    if (line.startsWith('#')) continue;
    const match = SEGMENT_URI.exec(line);
    if (match === null) fail(`unexpected URI line "${line.slice(0, 80)}"`);
    if (pendingDuration === null) fail(`segment ${line} without #EXTINF`);
    const index = Number((match as RegExpExecArray)[1]);
    if (index !== segments.length) fail(`segment ${line} out of order`);
    segments.push({ uri: line, index, durationSeconds: pendingDuration as number });
    pendingDuration = null;
  }
  if (segments.length === 0) fail('no segments');
  return segments;
}

/**
 * HLS `BANDWIDTH`: the peak segment bitrate (RFC 8216 §4.3.4.2). Segments shorter than 1 s (the
 * tail) are ignored unless they are all there is, so a tiny last segment cannot inflate it.
 */
export function peakBandwidthBps(
  segments: readonly { durationSeconds: number; bytes: number }[],
): number {
  const measurable = segments.filter((s) => s.durationSeconds >= 1);
  const pool = measurable.length > 0 ? measurable : segments;
  let peak = 0;
  for (const segment of pool) {
    const duration = Math.max(segment.durationSeconds, 0.001);
    peak = Math.max(peak, (segment.bytes * 8) / duration);
  }
  return Math.min(2_147_483_647, Math.max(1, Math.ceil(peak)));
}

export interface HlsVariantOutput {
  readonly uploads: UploadItem[];
  readonly bandwidthBps: number;
  readonly playlistKey: string;
}

/**
 * Checks one rendition directory written by ffmpeg (only `index.m3u8` and the segments it lists
 * may exist) and returns its upload items, segments first, playlist last.
 */
export async function collectHlsVariant(
  dir: string,
  outputPrefix: string,
  rendition: string,
  playlistText: string,
): Promise<HlsVariantOutput> {
  const segments = parseVariantPlaylist(playlistText);
  const expected = new Set([HLS_VARIANT_PLAYLIST_FILENAME, ...segments.map((s) => s.uri)]);
  const present = await readdir(dir);
  for (const name of present) {
    if (!expected.has(name)) {
      throw new TranscodeFailure('TRANSCODE_ERROR', `unexpected file ${rendition}/${name}`);
    }
  }
  const measured: { durationSeconds: number; bytes: number }[] = [];
  const uploads: UploadItem[] = [];
  for (const segment of segments) {
    const filePath = join(dir, segment.uri);
    const { size } = await stat(filePath);
    measured.push({ durationSeconds: segment.durationSeconds, bytes: size });
    uploads.push({
      filePath,
      key: hlsSegmentKey(outputPrefix, rendition, segment.index),
      contentType: CONTENT_TYPES.segment,
    });
  }
  const playlistKey = hlsVariantPlaylistKey(outputPrefix, rendition);
  uploads.push({
    filePath: join(dir, HLS_VARIANT_PLAYLIST_FILENAME),
    key: playlistKey,
    contentType: CONTENT_TYPES.playlist,
  });
  return { uploads, bandwidthBps: peakBandwidthBps(measured), playlistKey };
}
