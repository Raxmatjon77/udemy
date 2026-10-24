/**
 * Progress measurement (Phase 5 learning experience design D3, D4; decisions P5-D1/P5-D2).
 * Pure TypeScript: no Nest, no Redis, no SQL. Both `ProgressStore` implementations and the
 * heartbeat use case share these rules, so Redis and the direct DB path measure identically.
 *
 * - A VIDEO lecture is a bitmap of `bucketSeconds`-wide buckets (5 s): bit i = bucket i =
 *   Redis SETBIT offset i = the i-th bit of `learning.lecture_progress.coverage` (MSB-first).
 * - A played range `[from, to)` (whole seconds) marks buckets `floor(from / w)` to
 *   `floor((to - 1) / w)`, after clamping to `[0, duration]`.
 * - Plausibility (D3): the seconds accepted per heartbeat are bounded by the wall-clock time
 *   since the previous heartbeat (`elapsed × factor + slack`, `firstSeconds` on the first one).
 *   Excess ranges are dropped, keeping the NEWEST (the client lists them oldest first), so
 *   seeking to the end never counts and forging coverage needs real time.
 */

export interface PlayedRange {
  /** Inclusive start, whole seconds. */
  readonly from: number;
  /** Exclusive end, whole seconds (`to > from`). */
  readonly to: number;
}

/** An inclusive run of bucket indexes, `first <= last`. */
export interface BucketSpan {
  readonly first: number;
  readonly last: number;
}

export interface PlausibilityRules {
  /** Accepted seconds per elapsed wall-clock second (2.5: 2x playback still counts). */
  readonly factor: number;
  /** Added to every budget (10 s): absorbs client timer jitter. */
  readonly slackSeconds: number;
  /** Budget of the first heartbeat of a (user, lecture) (60 s). */
  readonly firstSeconds: number;
}

/** `ceil(durationSeconds / bucketSeconds)`; the bitmap length the DB CHECK enforces. */
export function bucketCountOf(durationSeconds: number, bucketSeconds: number): number {
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1) {
    throw new RangeError(`durationSeconds must be a positive integer, got ${durationSeconds}`);
  }
  if (!Number.isInteger(bucketSeconds) || bucketSeconds < 1) {
    throw new RangeError(`bucketSeconds must be a positive integer, got ${bucketSeconds}`);
  }
  return Math.ceil(durationSeconds / bucketSeconds);
}

/**
 * Seconds of new playback this heartbeat may contribute. `lastHeartbeatAtMs` null = the first
 * heartbeat of this (user, lecture). A clock that went backwards counts as zero elapsed time.
 */
export function plausibilityBudgetSeconds(
  lastHeartbeatAtMs: number | null,
  nowMs: number,
  rules: PlausibilityRules,
): number {
  if (lastHeartbeatAtMs === null) return rules.firstSeconds;
  const elapsedSeconds = Math.max(0, nowMs - lastHeartbeatAtMs) / 1000;
  return elapsedSeconds * rules.factor + rules.slackSeconds;
}

export interface AcceptedRanges {
  /** The kept ranges, clamped to the duration, oldest first. */
  readonly accepted: readonly PlayedRange[];
  /** Seconds of the dropped ranges (after clamping): over budget or beyond the duration. */
  readonly droppedSeconds: number;
}

/**
 * Clamps every range to `[0, durationSeconds]`, then keeps ranges from the newest backwards
 * while their total fits `budgetSeconds`; the first range that does not fit, and every older
 * one, is dropped whole (the contracts' mock store behaves identically).
 */
export function acceptPlayedRanges(
  ranges: readonly PlayedRange[],
  durationSeconds: number,
  budgetSeconds: number,
): AcceptedRanges {
  const kept: PlayedRange[] = [];
  let spent = 0;
  let dropped = 0;
  let exhausted = false;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    const from = clamp(Math.floor(range.from), 0, durationSeconds);
    const to = clamp(Math.ceil(range.to), 0, durationSeconds);
    const length = to - from;
    dropped += Math.max(0, Math.ceil(range.to) - Math.floor(range.from)) - Math.max(0, length);
    if (length <= 0) continue;
    if (exhausted || spent + length > budgetSeconds) {
      exhausted = true;
      dropped += length;
      continue;
    }
    spent += length;
    kept.push({ from, to });
  }
  return { accepted: kept.reverse(), droppedSeconds: Math.max(0, dropped) };
}

/** Bucket spans covered by `ranges` (sorted, merged; adjacent spans are joined). */
export function bucketSpansOf(
  ranges: readonly PlayedRange[],
  bucketSeconds: number,
): readonly BucketSpan[] {
  const raw = ranges
    .filter((r) => r.to > r.from)
    .map((r) => ({
      first: Math.floor(r.from / bucketSeconds),
      last: Math.floor((r.to - 1) / bucketSeconds),
    }))
    .sort((a, b) => a.first - b.first);
  const merged: BucketSpan[] = [];
  for (const span of raw) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && span.first <= previous.last + 1) {
      merged[merged.length - 1] = {
        first: previous.first,
        last: Math.max(previous.last, span.last),
      };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

/** D4 / P5-D2 in integers: covered / buckets >= pct / 100. */
export function meetsVideoCompletion(
  coveredBuckets: number,
  bucketCount: number,
  completePct: number,
): boolean {
  return bucketCount > 0 && coveredBuckets * 100 >= completePct * bucketCount;
}

/** ⌊covered / buckets × 100⌋, clamped to 0..100 (the player's `coveragePct`). */
export function coveragePctOf(coveredBuckets: number, bucketCount: number): number {
  if (bucketCount <= 0) return 0;
  return clamp(Math.floor((coveredBuckets * 100) / bucketCount), 0, 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The coverage bitmap of one (user, lecture, asset), MSB-first like Redis SETBIT and the DB
 * varbit (`@udemy/db` coverage.ts). Bits at or beyond `bucketCount` are never set.
 */
export class CoverageBitmap {
  private constructor(
    readonly bucketCount: number,
    private readonly bytes: Uint8Array,
  ) {}

  static empty(bucketCount: number): CoverageBitmap {
    return new CoverageBitmap(bucketCount, new Uint8Array(Math.ceil(bucketCount / 8)));
  }

  /** Copies `bytes`, dropping bits at or beyond `bucketCount`. */
  static fromBytes(bytes: Uint8Array, bucketCount: number): CoverageBitmap {
    const bitmap = CoverageBitmap.empty(bucketCount);
    bitmap.bytes.set(bytes.subarray(0, bitmap.bytes.length));
    bitmap.clearTail();
    return bitmap;
  }

  /** Sets every bucket of `spans` (indexes outside `0..bucketCount-1` are ignored). */
  withSpans(spans: readonly BucketSpan[]): CoverageBitmap {
    const next = CoverageBitmap.fromBytes(this.bytes, this.bucketCount);
    for (const span of spans) {
      const first = Math.max(0, span.first);
      const last = Math.min(this.bucketCount - 1, span.last);
      for (let i = first; i <= last; i++) next.bytes[i >> 3]! |= 0x80 >> (i & 7);
    }
    return next;
  }

  has(bucket: number): boolean {
    if (bucket < 0 || bucket >= this.bucketCount) return false;
    return (this.bytes[bucket >> 3]! & (0x80 >> (bucket & 7))) !== 0;
  }

  coveredBuckets(): number {
    let n = 0;
    for (let i = 0; i < this.bucketCount; i++) if (this.has(i)) n++;
    return n;
  }

  /** A copy of the bytes (MSB-first, last byte zero-padded). */
  toBytes(): Uint8Array {
    return this.bytes.slice();
  }

  private clearTail(): void {
    const tailBits = this.bucketCount & 7;
    if (tailBits !== 0 && this.bytes.length > 0) {
      this.bytes[this.bytes.length - 1]! &= (0xff << (8 - tailBits)) & 0xff;
    }
  }
}
