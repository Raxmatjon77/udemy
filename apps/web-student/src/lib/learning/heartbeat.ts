import {
  LEARNING_PROGRESS_RULES,
  type PlayedRange,
  type ProgressAck,
  type RecordHeartbeatRequest,
} from '@udemy/contracts';

/**
 * Progress heartbeats (learning experience design D2, D3, §10 "Heartbeat sequence").
 *
 * The player reports what was PLAYED (fractional ranges, seeks excluded). The sender buffers it
 * and PUTs `{positionSeconds, ranges}`:
 * - every `heartbeatIntervalSeconds` (15 s) while the video plays and the tab is visible;
 * - right away on pause, seek and end;
 * - on tab hide and `pagehide`, with `keepalive` so the request outlives the page.
 * Ranges go out in whole seconds (floor `from`, ceil `to`), clamped to the duration, merged and
 * capped at `maxRangesPerHeartbeat` (the newest kept). The server is authoritative: it merges
 * them into 5 s coverage buckets within a wall-clock plausibility budget and decides
 * completion at 90% (decision P5-D2); the client only shows what the ack says.
 *
 * Failures: a 429 drops the batch silently (the contract says so); 503 and network errors keep
 * it for the next beat; any other 4xx (enrollment gone, not a video) stops the sender.
 */

export interface FractionalRange {
  from: number;
  to: number;
}

/** Whole-second, clamped, merged ranges for the request (at most `maxRangesPerHeartbeat`). */
export function toHeartbeatRanges(
  ranges: readonly FractionalRange[],
  durationSeconds: number | null,
): PlayedRange[] {
  const max = Math.min(
    LEARNING_PROGRESS_RULES.maxSeconds,
    durationSeconds !== null && durationSeconds > 0
      ? Math.ceil(durationSeconds)
      : LEARNING_PROGRESS_RULES.maxSeconds,
  );
  const whole = ranges
    .map((r) => ({
      from: Math.max(0, Math.floor(r.from)),
      to: Math.min(max, Math.ceil(r.to)),
    }))
    .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from)
    .sort((a, b) => a.from - b.from);
  const merged: PlayedRange[] = [];
  for (const range of whole) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged.slice(-LEARNING_PROGRESS_RULES.maxRangesPerHeartbeat);
}

/** The status of a failed send, or null for a network error. */
export type HeartbeatFailure = { status: number | null };

export type HeartbeatSend = (
  body: RecordHeartbeatRequest,
  options: { keepalive: boolean },
) => Promise<ProgressAck>;

export interface HeartbeatListeners {
  onAck?: ((ack: ProgressAck) => void) | undefined;
  /** The sender stopped for good (403/404/422): enrollment gone, not a video, … */
  onStopped?: ((failure: HeartbeatFailure) => void) | undefined;
}

export interface HeartbeatSenderOptions extends HeartbeatListeners {
  send: HeartbeatSend;
  durationSeconds: number | null;
  /** Reads a failure's HTTP status (`ProxyFetchError.status`), or null. */
  statusOf?: (error: unknown) => number | null;
}

export class HeartbeatSender {
  private pending: FractionalRange[] = [];
  private position: number | null = null;
  private sentPosition: number | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  private listeners: HeartbeatListeners;

  constructor(private readonly options: HeartbeatSenderOptions) {
    this.listeners = { onAck: options.onAck, onStopped: options.onStopped };
  }

  /** Replaces the callbacks (a React component passes its latest ones after each render). */
  setListeners(listeners: HeartbeatListeners): void {
    this.listeners = listeners;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Buffers played ranges and the current position (nothing is sent yet). */
  record(ranges: readonly FractionalRange[], positionSeconds: number): void {
    if (this.stopped) return;
    this.pending.push(...ranges);
    if (Number.isFinite(positionSeconds) && positionSeconds >= 0) this.position = positionSeconds;
  }

  /** Whether a beat would carry anything new. */
  hasNews(): boolean {
    return (
      this.pending.length > 0 ||
      (this.position !== null && this.wholePosition(this.position) !== this.sentPosition)
    );
  }

  /**
   * Sends the buffer (if there is news). One request at a time: a call while one is in flight
   * sends again right after it. Resolves when the buffer was handed over.
   */
  flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.stopped || !this.hasNews()) return this.inFlight ?? Promise.resolve();
    if (options.keepalive) {
      // Leaving the page: do not wait for the request in flight, it may never finish.
      return this.sendNow(true);
    }
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = this.sendNow(false).finally(() => {
      this.inFlight = null;
      if (this.again) {
        this.again = false;
        void this.flush();
      }
    });
    return this.inFlight;
  }

  stop(): void {
    this.stopped = true;
    this.pending = [];
  }

  private wholePosition(seconds: number): number {
    const max =
      this.options.durationSeconds !== null && this.options.durationSeconds > 0
        ? Math.floor(this.options.durationSeconds)
        : LEARNING_PROGRESS_RULES.maxSeconds;
    return Math.min(max, LEARNING_PROGRESS_RULES.maxSeconds, Math.max(0, Math.floor(seconds)));
  }

  private async sendNow(keepalive: boolean): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    const positionSeconds = this.wholePosition(this.position ?? 0);
    const body: RecordHeartbeatRequest = {
      positionSeconds,
      ranges: toHeartbeatRanges(batch, this.options.durationSeconds),
    };
    try {
      const ack = await this.options.send(body, { keepalive });
      this.sentPosition = positionSeconds;
      if (!this.stopped) this.listeners.onAck?.(ack);
    } catch (error) {
      const status = this.options.statusOf?.(error) ?? null;
      if (status === 429) return; // dropped on purpose (design §9)
      if (status === null || status >= 500) {
        this.pending = [...batch, ...this.pending]; // retry with the next beat
        return;
      }
      if (status === 401) return; // the session layer handles it
      this.stop();
      this.listeners.onStopped?.({ status });
    }
  }
}
