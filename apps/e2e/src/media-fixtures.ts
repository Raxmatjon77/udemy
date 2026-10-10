import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { ffmpegPath, FIXTURES_DIR, hostHasFfmpeg, TRANSCODER_IMAGE } from './env';

/**
 * Media fixtures for the course journey, generated with ffmpeg's lavfi sources at setup time:
 * nothing binary is committed (design P2-T3/P2-T19). Written to `.output/fixtures/` (gitignored)
 * and deleted by global teardown.
 *
 * ffmpeg: the host's when it runs (CI installs it), otherwise the one in the transcoder image
 * (`docker run`; the compose transcoder of the same run builds that image when it is missing).
 */

export const MEDIA_FIXTURES = {
  /** 5 s 640x360 30 fps H.264 + 48 kHz AAC in MP4 (faststart), about 1 MB. */
  video: resolve(FIXTURES_DIR, 'lecture-5s.mp4'),
  /** 1280x720 PNG test card: a 16:9 course image above the 750x422 minimum. */
  thumbnail: resolve(FIXTURES_DIR, 'course-image.png'),
} as const;

const VIDEO_ARGS = [
  ...['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=5'],
  ...['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5'],
  ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p'],
  ...['-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart'],
];
const THUMBNAIL_ARGS = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:duration=1', '-frames:v', '1'];

/** Generates both fixtures (skips the ones that already exist). */
export async function generateMediaFixtures(): Promise<void> {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const runner = hostHasFfmpeg() ? hostFfmpeg : dockerFfmpeg;
  for (const [file, args] of [
    [MEDIA_FIXTURES.video, VIDEO_ARGS],
    [MEDIA_FIXTURES.thumbnail, THUMBNAIL_ARGS],
  ] as const) {
    if (existsSync(file) && statSync(file).size > 0) continue;
    const name = file.slice(FIXTURES_DIR.length + 1);
    await runner(name, args);
    if (!existsSync(file) || statSync(file).size === 0) {
      throw new Error(`ffmpeg did not write the fixture ${file}`);
    }
  }
}

export function removeMediaFixtures(): void {
  rmSync(FIXTURES_DIR, { recursive: true, force: true });
}

const COMMON = ['-hide_banner', '-nostdin', '-loglevel', 'error'];

function hostFfmpeg(name: string, args: readonly string[]): Promise<void> {
  return run(ffmpegPath, [...COMMON, ...args, '-y', resolve(FIXTURES_DIR, name)]);
}

/** ffmpeg of the transcoder image, offline, read-only, writing as the current user. */
function dockerFfmpeg(name: string, args: readonly string[]): Promise<void> {
  const user =
    typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? ['--user', `${process.getuid()}:${process.getgid()}`]
      : [];
  return run('docker', [
    'run',
    '--rm',
    '--read-only',
    '--network',
    'none',
    ...user,
    '-v',
    `${FIXTURES_DIR}:/out`,
    '--entrypoint',
    'ffmpeg',
    TRANSCODER_IMAGE,
    ...COMMON,
    ...args,
    '-y',
    `/out/${name}`,
  ]).catch((error: unknown) => {
    throw new Error(
      `No ffmpeg on the host and running it from the ${TRANSCODER_IMAGE} image failed. Install ` +
        'ffmpeg >= 6, or build the image (docker compose --env-file .env -f ' +
        'infra/docker/docker-compose.dev.yml --profile transcoder build transcoder).\n' +
        (error instanceof Error ? error.message : String(error)),
    );
  });
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}
