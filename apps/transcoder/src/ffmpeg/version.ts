/** The oldest ffmpeg/ffprobe whose behaviour the argument builders rely on (CI: Ubuntu 6.1). */
export const MIN_FFMPEG_MAJOR = 6;

export interface ToolVersion {
  readonly tool: 'ffmpeg' | 'ffprobe';
  /** As printed, e.g. `6.1.1-3ubuntu5` or `8.1.2`. */
  readonly version: string;
  readonly major: number;
  readonly minor: number;
}

/**
 * Parses the first line of `ffmpeg -version` / `ffprobe -version`:
 * `ffmpeg version 6.1.1-3ubuntu5 Copyright ...`, `ffmpeg version n7.1 ...`, `ffprobe version 8.1.2 ...`.
 * Git snapshots (`N-112233-g...`) and date-stamped builds carry no release number and return null.
 */
export function parseToolVersion(tool: 'ffmpeg' | 'ffprobe', output: string): ToolVersion | null {
  const firstLine = output.split('\n', 1)[0] ?? '';
  const match = new RegExp(`^${tool} version (n?(\\d+)\\.(\\d+)(?:\\.\\d+)?\\S*)`).exec(
    firstLine.trim(),
  );
  if (match === null) return null;
  return {
    tool,
    version: match[1] as string,
    major: Number(match[2]),
    minor: Number(match[3]),
  };
}

export class FfmpegVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegVersionError';
  }
}

/** Throws a boot-stopping error unless the version is parseable and at least MIN_FFMPEG_MAJOR. */
export function assertSupportedVersion(
  tool: 'ffmpeg' | 'ffprobe',
  path: string,
  output: string,
): ToolVersion {
  const version = parseToolVersion(tool, output);
  if (version === null) {
    const first = (output.split('\n', 1)[0] ?? '').slice(0, 200);
    throw new FfmpegVersionError(
      `${tool} at "${path}" printed an unrecognised version ("${first}"); ` +
        `the transcoder needs a release build of ${tool} >= ${MIN_FFMPEG_MAJOR}.`,
    );
  }
  if (version.major < MIN_FFMPEG_MAJOR) {
    throw new FfmpegVersionError(
      `${tool} ${version.version} found at "${path}"; the transcoder needs ${tool} >= ${MIN_FFMPEG_MAJOR}. ` +
        `Install a newer ffmpeg or point TRANSCODER_${tool.toUpperCase()}_PATH at one.`,
    );
  }
  return version;
}
