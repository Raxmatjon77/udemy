import { describe, expect, it } from 'vitest';
import { GIF_BYTES, PDF_BYTES, pngHeader } from '../testing/fixtures';
import { checkMagic, detectType, readImageDimensions } from './magic-bytes';

const bytes = (...values: (number | string)[]): Buffer =>
  Buffer.concat(
    values.map((v) => (typeof v === 'string' ? Buffer.from(v, 'latin1') : Buffer.from([v]))),
  );
const box = (type: string): Buffer => bytes(0, 0, 0, 0x18, type, 'isom', 0, 0, 2, 0);

describe('detectType', () => {
  it.each([
    ['ftyp box (mp4/mov)', 'isobmff', box('ftyp')],
    ['QuickTime starting with moov', 'isobmff', box('moov')],
    ['QuickTime starting with wide', 'isobmff', box('wide')],
    ['Matroska/WebM EBML', 'matroska', bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f)],
    ['AVI', 'avi', bytes('RIFF', 0, 0, 0, 0, 'AVI LIST')],
    ['WebP', 'webp', bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')],
    ['PNG', 'png', pngHeader(10, 10)],
    ['JPEG', 'jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['GIF', 'gif', GIF_BYTES],
    ['PDF', 'pdf', PDF_BYTES],
    ['ZIP', 'zip', bytes('PK', 3, 4, 20, 0)],
    ['empty ZIP', 'zip', bytes('PK', 5, 6, 0, 0)],
    ['HLS playlist', 'unknown', bytes('#EXTM3U\n#EXTINF:5,\n')],
    ['ffconcat script', 'unknown', bytes('ffconcat version 1.0\n')],
    ['SVG', 'unknown', bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['HTML', 'unknown', bytes('<!doctype html><script>')],
    ['RIFF WAVE', 'unknown', bytes('RIFF', 0, 0, 0, 0, 'WAVEfmt ')],
    ['empty', 'unknown', Buffer.alloc(0)],
  ])('%s -> %s', (_, expected, head) => {
    expect(detectType(head)).toBe(expected);
  });
});

describe('checkMagic', () => {
  it('accepts each purpose family only', () => {
    expect(checkMagic('LECTURE_VIDEO', box('ftyp'))).toEqual({ ok: true, type: 'isobmff' });
    expect(checkMagic('COURSE_THUMBNAIL', pngHeader(1, 1))).toEqual({ ok: true, type: 'png' });
    expect(checkMagic('LECTURE_RESOURCE', PDF_BYTES)).toEqual({ ok: true, type: 'pdf' });
  });

  it('a known type in the wrong purpose is UNSUPPORTED_MEDIA (polyglots, GIF, video as resource)', () => {
    expect(checkMagic('LECTURE_VIDEO', Buffer.concat([pngHeader(1, 1), box('ftyp')]))).toEqual({
      ok: false,
      code: 'UNSUPPORTED_MEDIA',
      type: 'png',
    });
    expect(checkMagic('COURSE_THUMBNAIL', GIF_BYTES)).toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    expect(checkMagic('LECTURE_RESOURCE', box('ftyp'))).toMatchObject({
      code: 'UNSUPPORTED_MEDIA',
    });
    expect(checkMagic('COURSE_THUMBNAIL', PDF_BYTES)).toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });

  it('unrecognisable bytes are INVALID_MEDIA', () => {
    expect(checkMagic('LECTURE_VIDEO', bytes('#EXTM3U\n'))).toEqual({
      ok: false,
      code: 'INVALID_MEDIA',
      type: 'unknown',
    });
  });
});

describe('readImageDimensions (header only, no decode)', () => {
  it('PNG IHDR', () => {
    expect(readImageDimensions('png', pngHeader(65535, 65535))).toEqual({
      width: 65535,
      height: 65535,
    });
  });

  it('JPEG: walks APPn segments to the SOF marker', () => {
    const app0 = bytes(0xff, 0xe0, 0, 16, 'JFIF', 0, 1, 2, 0, 0, 1, 0, 1, 0, 0);
    const app1 = Buffer.concat([bytes(0xff, 0xe1, 0x01, 0x02), Buffer.alloc(0x0100)]);
    const sof2 = bytes(0xff, 0xc2, 0, 17, 8, 0x04, 0xb0, 0x06, 0x40, 3);
    const jpeg = Buffer.concat([bytes(0xff, 0xd8), app0, app1, sof2]);
    expect(readImageDimensions('jpeg', jpeg)).toEqual({ width: 1600, height: 1200 });
    expect(
      readImageDimensions(
        'jpeg',
        Buffer.concat([bytes(0xff, 0xd8), app0, bytes(0xff, 0xda, 0, 2)]),
      ),
    ).toBeNull();
    expect(readImageDimensions('jpeg', bytes(0xff, 0xd8, 0x00, 0x00))).toBeNull();
  });

  it('WebP: VP8, VP8L and VP8X', () => {
    const vp8 = Buffer.alloc(30);
    vp8.write('RIFF', 0, 'latin1');
    vp8.write('WEBPVP8 ', 8, 'latin1');
    vp8.set([0x9d, 0x01, 0x2a], 23);
    vp8.writeUInt16LE(1600, 26);
    vp8.writeUInt16LE(1200, 28);
    expect(readImageDimensions('webp', vp8)).toEqual({ width: 1600, height: 1200 });

    const vp8l = Buffer.alloc(25);
    vp8l.write('RIFF', 0, 'latin1');
    vp8l.write('WEBPVP8L', 8, 'latin1');
    vp8l[20] = 0x2f;
    vp8l.writeUInt32LE((1599 & 0x3fff) | ((1199 & 0x3fff) << 14), 21);
    expect(readImageDimensions('webp', vp8l)).toEqual({ width: 1600, height: 1200 });

    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF', 0, 'latin1');
    vp8x.write('WEBPVP8X', 8, 'latin1');
    vp8x.writeUIntLE(16383, 24, 3);
    vp8x.writeUIntLE(16383, 27, 3);
    expect(readImageDimensions('webp', vp8x)).toEqual({ width: 16384, height: 16384 });
  });

  it('null for truncated headers and non-images', () => {
    expect(readImageDimensions('png', pngHeader(1, 1).subarray(0, 20))).toBeNull();
    expect(readImageDimensions('pdf', PDF_BYTES)).toBeNull();
  });
});
