/**
 * Played-range tracking for `<HlsPlayer>` (Phase 5 learning experience design D3, §10, risk
 * "T8: prefer our own range tracking over `video.played`", which a source change resets).
 *
 * The tracker is fed the media's `currentTime` on every `timeupdate` while it plays. Consecutive
 * samples that move forward by at most `maxStepSeconds` extend the open range; anything else
 * (a seek, a stall longer than the step, a jump back) closes it and opens a new one. Seeking,
 * pausing and ending close the open range explicitly, so skipping to the end never counts as
 * watched. The server merges what it receives into its own coverage buckets and clamps it to a
 * wall-clock plausibility budget; the tracker only reports honestly what was played.
 */

export interface PlayedRangeSeconds {
  /** Start of the range, in seconds (fractional). */
  from: number;
  /** End of the range, in seconds (fractional, > from). */
  to: number;
}

export interface PlayedRangeTrackerOptions {
  /**
   * Largest forward step between two samples that still counts as continuous playback.
   * `timeupdate` fires every 15–250 ms; 4 s tolerates 4× playback and a busy main thread.
   */
  maxStepSeconds?: number;
}

const DEFAULT_MAX_STEP_SECONDS = 4;

/** Sorts and merges overlapping or touching ranges. */
export function mergePlayedRanges(ranges: readonly PlayedRangeSeconds[]): PlayedRangeSeconds[] {
  const sorted = ranges.filter((r) => r.to > r.from).sort((a, b) => a.from - b.from);
  const out: PlayedRangeSeconds[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      out.push({ from: range.from, to: range.to });
    }
  }
  return out;
}

export class PlayedRangeTracker {
  private readonly maxStep: number;
  private readonly closed: PlayedRangeSeconds[] = [];
  /** The open range: `[start, last]`, or null while not tracking. */
  private start: number | null = null;
  private last = 0;

  constructor(options: PlayedRangeTrackerOptions = {}) {
    this.maxStep = options.maxStepSeconds ?? DEFAULT_MAX_STEP_SECONDS;
  }

  /** The last observed playback position. */
  get position(): number {
    return this.last;
  }

  /** A `timeupdate` sample while the media is playing. */
  observe(time: number): void {
    if (!Number.isFinite(time) || time < 0) return;
    if (this.start === null) {
      this.start = time;
      this.last = time;
      return;
    }
    const step = time - this.last;
    if (step < 0 || step > this.maxStep) {
      this.close();
      this.start = time;
    }
    this.last = time;
  }

  /**
   * Ends the open range at the last sample (on `seeking`, `pause`, `ended`, `waiting`). The
   * next `observe` opens a new range. Pass `at` to extend to a final sample first (`pause`).
   */
  cut(at?: number): void {
    if (at !== undefined && this.start !== null) this.observe(at);
    this.close();
  }

  /** Moves the position without counting anything as played (a programmatic seek). */
  jumpTo(time: number): void {
    this.close();
    if (Number.isFinite(time) && time >= 0) this.last = time;
  }

  /**
   * Returns everything played since the previous `take`, merged, and keeps tracking: the open
   * range is split at its last sample so continuous playback is reported in both halves.
   */
  take(): PlayedRangeSeconds[] {
    if (this.start !== null && this.last > this.start) {
      this.closed.push({ from: this.start, to: this.last });
      this.start = this.last;
    }
    const out = mergePlayedRanges(this.closed);
    this.closed.length = 0;
    return out;
  }

  private close(): void {
    if (this.start !== null && this.last > this.start) {
      this.closed.push({ from: this.start, to: this.last });
    }
    this.start = null;
  }
}
