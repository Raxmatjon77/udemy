/**
 * Parser for `ffmpeg -progress pipe:1`: blocks of `key=value` lines, each closed by
 * `progress=continue` or `progress=end`.
 *
 *   out_time_us=4933333
 *   out_time_ms=4933333      (also microseconds: a historic ffmpeg misnomer)
 *   out_time=00:00:04.933333
 *   speed=2.81x
 *   progress=continue
 */
export interface FfmpegProgress {
  /** Output timestamp reached, in microseconds (null until ffmpeg reports one). */
  readonly outTimeUs: number | null;
  /** Encoding speed relative to real time (null when N/A). */
  readonly speed: number | null;
  /** True for the final block (`progress=end`). */
  readonly done: boolean;
}

const TIMESTAMP = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/;

function parseOutTime(block: ReadonlyMap<string, string>): number | null {
  for (const key of ['out_time_us', 'out_time_ms']) {
    const raw = block.get(key);
    if (raw !== undefined && /^\d+$/.test(raw)) return Number(raw);
  }
  const text = block.get('out_time');
  const match = text === undefined ? null : TIMESTAMP.exec(text);
  if (match === null) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Math.round(seconds * 1_000_000);
}

export class FfmpegProgressParser {
  private block = new Map<string, string>();
  private lastOutTimeUs: number | null = null;

  /** Feeds one line; returns a snapshot when the line closes a block, else null. */
  push(line: string): FfmpegProgress | null {
    const eq = line.indexOf('=');
    if (eq <= 0) return null;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key !== 'progress') {
      this.block.set(key, value);
      return null;
    }
    const outTimeUs = parseOutTime(this.block);
    // Timestamps can briefly go N/A or backwards (B-frames, several outputs): keep the maximum.
    if (outTimeUs !== null && (this.lastOutTimeUs === null || outTimeUs > this.lastOutTimeUs)) {
      this.lastOutTimeUs = outTimeUs;
    }
    const speedMatch = /^(\d+(?:\.\d+)?)x$/.exec(this.block.get('speed') ?? '');
    this.block = new Map();
    return {
      outTimeUs: this.lastOutTimeUs,
      speed: speedMatch === null ? null : Number(speedMatch[1]),
      done: value === 'end',
    };
  }
}

/**
 * Percentage of `durationMs` reached, clamped to 0..99: 100 is reported only by the completing
 * transaction (`completeTranscodeJob`).
 */
export function progressPercent(outTimeUs: number | null, durationMs: number): number {
  if (outTimeUs === null || !(durationMs > 0)) return 0;
  const pct = Math.floor((outTimeUs / 1000 / durationMs) * 100);
  return Math.max(0, Math.min(99, pct));
}
