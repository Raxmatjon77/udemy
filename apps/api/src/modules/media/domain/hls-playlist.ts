import { PlaylistRejected } from './media.errors';

/**
 * HLS v3 playlists (design D7, D15). Pure text work; signing and storage live in the
 * application layer.
 */

export const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

/** One HLS_VARIANT rendition row (`media.asset_renditions`). */
export interface HlsVariant {
  /** `360p`, `720p`, `src540p`, ... (validated by the DB CHECK and the storage key helpers). */
  readonly name: string;
  readonly bandwidthBps: number;
  readonly width: number;
  readonly height: number;
  /** RFC 6381 codecs, e.g. `avc1.4d401f,mp4a.40.2` (CHECK: `^[A-Za-z0-9.,]+$`). */
  readonly codecs: string;
}

const RENDITION_FILE = /^[A-Za-z0-9]+$/;
const CODECS = /^[A-Za-z0-9.,]+$/;

/**
 * The master playlist, built from DB rows (no master is stored, D7). Variant URIs are RELATIVE
 * (`720p.m3u8`), so the player resolves them against the master's own URL and every variant
 * request goes back through the same authorized route. Ordered by bandwidth, lowest first.
 */
export function renderMasterPlaylist(variants: readonly HlsVariant[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  const ordered = [...variants].sort(
    (a, b) => a.bandwidthBps - b.bandwidthBps || a.height - b.height,
  );
  for (const v of ordered) {
    // Defence in depth: the values come from our DB, but they end up in a text protocol.
    if (!RENDITION_FILE.test(v.name) || !CODECS.test(v.codecs)) {
      throw new PlaylistRejected(`invalid rendition row "${v.name}"`);
    }
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.trunc(v.bandwidthBps)},` +
        `RESOLUTION=${Math.trunc(v.width)}x${Math.trunc(v.height)},CODECS="${v.codecs}"`,
      `${v.name}.m3u8`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export type PlaylistLine =
  { readonly kind: 'text'; readonly text: string } | { readonly kind: 'uri'; readonly uri: string };

/** More segment lines than this is not a playlist our transcoder wrote (4 h / 6 s = 2400). */
export const MAX_PLAYLIST_URIS = 20_000;

/** Tags that carry URIs this rewriter does not sign (keys, fMP4 init maps, nested media). */
const URI_ATTRIBUTE = /URI\s*=/i;
const FORBIDDEN_TAGS = ['#EXT-X-STREAM-INF', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-MEDIA:'];

/**
 * Parses a stored variant playlist into tag/comment lines (kept verbatim) and URI lines (to be
 * replaced by presigned GETs). Only plain MPEG-TS variants are accepted (D15).
 *
 * @throws PlaylistRejected when it is not an HLS playlist, carries URI attributes or nested
 *   playlists, or has an implausible number of segments
 */
export function parseVariantPlaylist(text: string): PlaylistLine[] {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines[0]?.replace(/^\uFEFF/, '').trim() !== '#EXTM3U') {
    throw new PlaylistRejected('missing #EXTM3U header');
  }
  const parsed: PlaylistLine[] = [];
  let uris = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      if (URI_ATTRIBUTE.test(line) || FORBIDDEN_TAGS.some((tag) => line.startsWith(tag))) {
        throw new PlaylistRejected(`unsupported tag "${line.slice(0, 40)}"`);
      }
      parsed.push({ kind: 'text', text: line });
      continue;
    }
    uris += 1;
    if (uris > MAX_PLAYLIST_URIS) throw new PlaylistRejected('too many segments');
    parsed.push({ kind: 'uri', uri: line });
  }
  return parsed;
}

/** The URI lines of a parsed playlist, in order (duplicates kept). */
export function playlistUris(lines: readonly PlaylistLine[]): string[] {
  return lines.flatMap((line) => (line.kind === 'uri' ? [line.uri] : []));
}

/**
 * Re-serializes a parsed playlist with every URI line replaced by `urlFor(uri)`.
 *
 * @throws PlaylistRejected when `urlFor` has no URL for a line (a bug in the caller)
 */
export function serializePlaylist(
  lines: readonly PlaylistLine[],
  urlFor: (uri: string) => string | undefined,
): string {
  const out = lines.map((line) => {
    if (line.kind === 'text') return line.text;
    const url = urlFor(line.uri);
    if (url === undefined) throw new PlaylistRejected(`no signed URL for "${line.uri}"`);
    return url;
  });
  return `${out.join('\n')}\n`;
}
