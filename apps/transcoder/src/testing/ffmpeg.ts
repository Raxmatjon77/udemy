import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { type ToolchainPaths, verifyToolchain } from '../ffmpeg/ffmpeg-toolchain.service';

/**
 * Gate for tests that run the real ffmpeg/ffprobe (fixtures are generated at test time with
 * `-f lavfi`; no media binaries live in git).
 *
 * - Binaries: TRANSCODER_FFMPEG_PATH / TRANSCODER_FFPROBE_PATH, default `ffmpeg` / `ffprobe` on PATH.
 * - Locally, a missing (or < 6) ffmpeg SKIPS these tests with a clear message.
 * - With `CI=true` it FAILS: CI installs ffmpeg >= 6 and must never go green by skipping.
 */
export function ffmpegPaths(): ToolchainPaths {
  const pick = (name: string, fallback: string): string => {
    const value = process.env[name];
    return value === undefined || value.trim() === '' ? fallback : value.trim();
  };
  return {
    ffmpeg: pick('TRANSCODER_FFMPEG_PATH', 'ffmpeg'),
    ffprobe: pick('TRANSCODER_FFPROBE_PATH', 'ffprobe'),
  };
}

export interface SkippableContext {
  skip(condition: boolean, note?: string): void;
}

export interface FfmpegTestEnv {
  readonly paths: ToolchainPaths;
  /** Scratch dir of this test file (removed afterwards). Throws when ffmpeg is unavailable. */
  readonly dir: string;
  readonly unavailableReason: string | undefined;
  skipIfUnavailable(ctx: SkippableContext): void;
}

export function useFfmpeg(): FfmpegTestEnv {
  const paths = ffmpegPaths();
  let reason: string | undefined = 'not checked yet (used outside a test?)';
  let dir: string | undefined;

  beforeAll(async () => {
    try {
      await verifyToolchain(paths);
      reason = undefined;
      dir = await mkdtemp(join(tmpdir(), 'transcoder-test-'));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (process.env.CI === 'true') {
        throw new Error(`[ffmpeg] ${why} CI=true: ffmpeg tests must not be skipped.`, {
          cause: error,
        });
      }
      process.stderr.write(`[ffmpeg] ${why} Skipping the ffmpeg-based tests.\n`);
      reason = why;
    }
  });

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  return {
    paths,
    get dir(): string {
      if (dir === undefined) throw new Error(`[ffmpeg] unavailable: ${reason ?? 'no dir'}`);
      return dir;
    },
    get unavailableReason(): string | undefined {
      return reason;
    },
    skipIfUnavailable(ctx: SkippableContext): void {
      ctx.skip(reason !== undefined, reason);
    },
  };
}
