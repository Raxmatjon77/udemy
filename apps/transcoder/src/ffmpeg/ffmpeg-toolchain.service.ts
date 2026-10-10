import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ProcessError, type ProcessResult, runProcess, type RunProcessOptions } from './process';
import { assertSupportedVersion, FfmpegVersionError, type ToolVersion } from './version';

const VERSION_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;
const HEALTH_CACHE_MS = 30_000;

export type FfmpegTool = 'ffmpeg' | 'ffprobe';

export interface ToolchainPaths {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

/** Injection token for the binaries' paths (TRANSCODER_FFMPEG_PATH / TRANSCODER_FFPROBE_PATH). */
export const TOOLCHAIN_PATHS = Symbol.for('udemy.transcoder.TOOLCHAIN_PATHS');

/**
 * The ffmpeg/ffprobe binaries of this process. The boot check (onModuleInit) runs `-version` on
 * both and refuses to start below major 6, so a missing or ancient ffmpeg fails the deploy instead
 * of failing every job.
 */
@Injectable()
export class FfmpegToolchain implements OnModuleInit {
  private readonly logger = new Logger(FfmpegToolchain.name);
  private versions: { ffmpeg: ToolVersion; ffprobe: ToolVersion } | undefined;
  private health: { checkedAt: number; ok: boolean; message?: string } | undefined;

  constructor(@Inject(TOOLCHAIN_PATHS) readonly paths: ToolchainPaths) {}

  async onModuleInit(): Promise<void> {
    const versions = await verifyToolchain(this.paths);
    this.versions = versions;
    this.logger.log(
      `ffmpeg ${versions.ffmpeg.version} (${this.paths.ffmpeg}), ffprobe ${versions.ffprobe.version} (${this.paths.ffprobe})`,
    );
  }

  get detectedVersions(): { ffmpeg: ToolVersion; ffprobe: ToolVersion } | undefined {
    return this.versions;
  }

  run(
    tool: FfmpegTool,
    args: readonly string[],
    options?: RunProcessOptions,
  ): Promise<ProcessResult> {
    return runProcess(this.paths[tool], args, options);
  }

  /** Readiness: both binaries still execute (cached for 30 s). */
  async checkAvailable(): Promise<{ ok: boolean; message?: string }> {
    const now = Date.now();
    if (this.health !== undefined && now - this.health.checkedAt < HEALTH_CACHE_MS) {
      return this.health;
    }
    try {
      await verifyToolchain(this.paths, HEALTH_TIMEOUT_MS);
      this.health = { checkedAt: now, ok: true };
    } catch (error) {
      this.health = {
        checkedAt: now,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return this.health;
  }
}

/** Runs `<tool> -version` for both tools; throws FfmpegVersionError with a clear message. */
export async function verifyToolchain(
  paths: ToolchainPaths,
  timeoutMs: number = VERSION_TIMEOUT_MS,
): Promise<{ ffmpeg: ToolVersion; ffprobe: ToolVersion }> {
  const check = async (tool: FfmpegTool): Promise<ToolVersion> => {
    const path = paths[tool];
    let output: string;
    try {
      ({ stdout: output } = await runProcess(path, ['-hide_banner', '-version'], {
        timeoutMs,
        maxStdoutBytes: 64 * 1024,
      }));
    } catch (error) {
      const reason =
        error instanceof ProcessError && error.kind === 'spawn'
          ? 'it was not found or is not executable'
          : error instanceof Error
            ? error.message
            : String(error);
      throw new FfmpegVersionError(
        `Cannot run ${tool} at "${path}" (${reason}). Install ffmpeg >= 6 or set TRANSCODER_${tool.toUpperCase()}_PATH.`,
      );
    }
    return assertSupportedVersion(tool, path, output);
  };
  // Sequential: the first error reported is deterministic.
  const ffmpeg = await check('ffmpeg');
  const ffprobe = await check('ffprobe');
  return { ffmpeg, ffprobe };
}
