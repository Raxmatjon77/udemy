import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolchainPaths } from '../ffmpeg/ffmpeg-toolchain.service';
import { runProcess } from '../ffmpeg/process';

/**
 * Media fixtures generated at test time from ffmpeg's lavfi sources (testsrc2 + sine) or crafted
 * byte by byte. Nothing binary is committed.
 */

async function lavfi(paths: ToolchainPaths, args: readonly string[]): Promise<void> {
  await runProcess(paths.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
    timeoutMs: 120_000,
  });
}

const X264_FAST = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

function video(size: string, rate: number, seconds: number): string[] {
  return ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`];
}

function tone(seconds: number): string[] {
  return ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`];
}

/** 5 s 1280x720 30 fps H.264 + AAC in MP4. */
export async function clip720(paths: ToolchainPaths, dir: string, seconds = 5): Promise<string> {
  const out = join(dir, `clip720-${seconds}s.mp4`);
  await lavfi(paths, [
    ...video('1280x720', 30, seconds),
    ...tone(seconds),
    ...X264_FAST,
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-shortest',
    '-movflags',
    '+faststart',
    '-y',
    out,
  ]);
  return out;
}

/** 3 s portrait 540x960 in QuickTime (.mov), with audio. */
export async function portraitClip(paths: ToolchainPaths, dir: string): Promise<string> {
  const out = join(dir, 'portrait.mov');
  await lavfi(paths, [
    ...video('540x960', 25, 3),
    ...tone(3),
    ...X264_FAST,
    '-c:a',
    'aac',
    '-shortest',
    '-f',
    'mov',
    '-y',
    out,
  ]);
  return out;
}

/** 3 s 640x360 H.264 in Matroska, no audio stream at all. */
export async function silentClip(paths: ToolchainPaths, dir: string, seconds = 3): Promise<string> {
  const out = join(dir, `silent-${seconds}s.mkv`);
  await lavfi(paths, [...video('640x360', 25, seconds), ...X264_FAST, '-f', 'matroska', '-y', out]);
  return out;
}

/**
 * A valid short Matroska file whose header DECLARES a duration of 1e8 ms (~27.8 h): the Segment
 * Info `Duration` float (EBML id 0x4489, size 0x88) is patched in place.
 */
export async function declaredTooLong(paths: ToolchainPaths, dir: string): Promise<string> {
  const source = await silentClip(paths, dir, 2);
  const bytes = await readFile(source);
  const at = bytes.indexOf(Buffer.from([0x44, 0x89, 0x88]));
  if (at < 0) throw new Error('no Matroska Duration element found');
  bytes.writeDoubleBE(1e8, at + 3);
  const out = join(dir, 'declared-too-long.mkv');
  await writeFile(out, bytes);
  return out;
}

/** ISO BMFF magic (an ftyp box) followed by garbage: passes the sniffing, fails ffprobe. */
export async function corruptVideo(dir: string): Promise<string> {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ]);
  const garbage = Buffer.alloc(64 * 1024);
  for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 2654435761) >>> 24;
  const out = join(dir, 'corrupt.mp4');
  await writeFile(out, Buffer.concat([ftyp, garbage]));
  return out;
}

/** A PNG signature + IHDR glued in front of a real MP4 (an image/video polyglot). */
export async function pngVideoPolyglot(paths: ToolchainPaths, dir: string): Promise<string> {
  const mp4 = await readFile(await clip720(paths, dir, 1));
  const out = join(dir, 'polyglot.png.mp4');
  await writeFile(out, Buffer.concat([pngHeader(320, 240), mp4]));
  return out;
}

/** An HLS playlist that would make an unrestricted ffmpeg read a local file. */
export async function hlsPlaylistTrap(dir: string, target: string): Promise<string> {
  const out = join(dir, 'trap.m3u8');
  await writeFile(
    out,
    `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5,\nfile://${target}\n#EXT-X-ENDLIST\n`,
  );
  return out;
}

/** An ffconcat script pointing at a local file. */
export async function concatTrap(dir: string, target: string): Promise<string> {
  const out = join(dir, 'trap.ffconcat');
  await writeFile(out, `ffconcat version 1.0\nfile ${target}\n`);
  return out;
}

/** A still image in png/jpeg/webp (encoded by ffmpeg from testsrc2). */
export async function stillImage(
  paths: ToolchainPaths,
  dir: string,
  format: 'png' | 'jpeg' | 'webp',
  size = '1600x1200',
): Promise<string> {
  const out = join(dir, `still-${size}.${format === 'jpeg' ? 'jpg' : format}`);
  const codec = { png: 'png', jpeg: 'mjpeg', webp: 'libwebp' }[format];
  const pipe = { png: 'image2', jpeg: 'image2', webp: 'webp' }[format];
  await lavfi(paths, [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=1:duration=1`,
    '-frames:v',
    '1',
    '-c:v',
    codec,
    ...(format === 'jpeg' ? ['-pix_fmt', 'yuvj420p'] : []),
    '-f',
    pipe,
    ...(pipe === 'image2' ? ['-update', '1'] : []),
    '-y',
    out,
  ]);
  return out;
}

/** PNG signature + IHDR declaring `width x height` (no image data): a decompression-bomb header. */
export function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 2; // colour type RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

export const GIF_BYTES = Buffer.from(
  'GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!',
  'latin1',
);
export const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n',
);
