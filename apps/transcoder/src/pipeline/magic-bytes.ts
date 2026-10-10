import type { MediaPurpose } from '@udemy/contracts';

/**
 * Content sniffing by magic bytes (design §9, D10): the declared Content-Type is advisory, the
 * first bytes decide. Runs before ffprobe so that a file of the wrong family never reaches a
 * demuxer, and before anything is copied for LECTURE_RESOURCE.
 */
export type DetectedType =
  'isobmff' | 'matroska' | 'avi' | 'jpeg' | 'png' | 'webp' | 'gif' | 'pdf' | 'zip' | 'unknown';

/** Bytes needed by `detectType`. */
export const MAGIC_HEAD_BYTES = 16;

/** Top-level ISO BMFF / QuickTime atoms a movie file can start with. */
const ISOBMFF_FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip']);

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.length >= end ? buf.toString('latin1', start, end) : '';
}

function startsWith(buf: Buffer, bytes: readonly number[]): boolean {
  return buf.length >= bytes.length && bytes.every((byte, i) => buf[i] === byte);
}

export function detectType(head: Buffer): DetectedType {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'matroska';
  if (ascii(head, 0, 4) === 'RIFF') {
    const form = ascii(head, 8, 12);
    if (form === 'WEBP') return 'webp';
    if (form === 'AVI ') return 'avi';
    return 'unknown';
  }
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(head, 0, 5) === '%PDF-') return 'pdf';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    return 'zip';
  }
  if (ISOBMFF_FIRST_BOXES.has(ascii(head, 4, 8))) return 'isobmff';
  return 'unknown';
}

/** What each purpose accepts (mirrors MEDIA_PURPOSE_RULES content types, decided by content). */
export const ALLOWED_TYPES: Readonly<Record<MediaPurpose, readonly DetectedType[]>> = {
  LECTURE_VIDEO: ['isobmff', 'matroska', 'avi'],
  COURSE_THUMBNAIL: ['jpeg', 'png', 'webp'],
  LECTURE_RESOURCE: ['pdf', 'zip'],
};

export type MagicVerdict =
  | { readonly ok: true; readonly type: DetectedType }
  /** A known type that this purpose does not accept (UNSUPPORTED_MEDIA). */
  | { readonly ok: false; readonly code: 'UNSUPPORTED_MEDIA'; readonly type: DetectedType }
  /** Not recognisable as anything we know (INVALID_MEDIA). */
  | { readonly ok: false; readonly code: 'INVALID_MEDIA'; readonly type: 'unknown' };

export function checkMagic(purpose: MediaPurpose, head: Buffer): MagicVerdict {
  const type = detectType(head);
  if (ALLOWED_TYPES[purpose].includes(type)) return { ok: true, type };
  if (type === 'unknown') return { ok: false, code: 'INVALID_MEDIA', type };
  return { ok: false, code: 'UNSUPPORTED_MEDIA', type };
}

// ------------------------------------------------------------------------------ image headers

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Bytes read for `readImageDimensions` (JPEG APPn segments may precede the SOF marker). */
export const IMAGE_HEADER_BYTES = 512 * 1024;

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(buf: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    let marker = buf[offset + 1] as number;
    while (marker === 0xff && offset + 2 < buf.length) {
      offset += 1;
      marker = buf[offset + 1] as number;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function pngDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24 || ascii(buf, 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function webpDimensions(buf: Buffer): ImageDimensions | null {
  const chunk = ascii(buf, 12, 16);
  if (chunk === 'VP8X' && buf.length >= 30) {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/**
 * Width/height from the image header, WITHOUT decoding (the pixel-count cap must apply before any
 * decoder allocates a frame: a 65535x65535 PNG is a few KB on disk). Null when not determinable.
 */
export function readImageDimensions(type: DetectedType, head: Buffer): ImageDimensions | null {
  switch (type) {
    case 'png':
      return pngDimensions(head);
    case 'jpeg':
      return jpegDimensions(head);
    case 'webp':
      return webpDimensions(head);
    default:
      return null;
  }
}
