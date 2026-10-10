import type { Logger } from '@nestjs/common';
import { type DB, heartbeatTranscodeJob, type Kysely, type LeaseFence } from '@udemy/db';

export interface LeaseHeartbeatOptions {
  readonly db: Kysely<DB>;
  readonly fence: LeaseFence;
  readonly leaseMs: number;
  /** LEASE_MS / 3: two missed beats still leave the lease alive. */
  readonly intervalMs: number;
  /** Called once when the lease is (or must be assumed) lost. */
  readonly onLost: (reason: string) => void;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * Extends the lease every `intervalMs` (fenced on lease_count) and carries the progress. A 0-row
 * heartbeat means the lease was reaped/re-leased: `onLost` aborts the work. If heartbeats keep
 * failing (DB down) for a whole lease length, the lease may have expired; that counts as lost too.
 */
export class LeaseHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  private progressPct = 0;
  private lastSuccess = Date.now();
  private lost = false;

  constructor(private readonly options: LeaseHeartbeatOptions) {}

  start(): void {
    this.timer = setInterval(() => void this.beat(), this.options.intervalMs);
  }

  /** Progress never moves backwards (the SQL keeps the maximum as well). */
  report(pct: number): void {
    this.progressPct = Math.max(this.progressPct, Math.min(99, Math.max(0, Math.floor(pct))));
  }

  get progress(): number {
    return this.progressPct;
  }

  get isLost(): boolean {
    return this.lost;
  }

  /** One heartbeat now (also used by tests). */
  beat(): Promise<void> {
    if (this.lost) return Promise.resolve();
    if (this.inflight !== undefined) return this.inflight;
    this.inflight = this.doBeat().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Stops the timer and waits for an in-flight heartbeat. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.inflight;
  }

  private async doBeat(): Promise<void> {
    const { fence } = this.options;
    try {
      const expires = await heartbeatTranscodeJob(this.options.db, {
        ...fence,
        leaseMs: this.options.leaseMs,
        progressPct: this.progressPct,
      });
      if (expires === null) {
        this.markLost(`lease ${fence.assetId}/a${fence.leaseNo} lost (heartbeat matched no row)`);
        return;
      }
      this.lastSuccess = Date.now();
    } catch (error) {
      this.options.logger.warn(
        { err: error, assetId: fence.assetId, leaseNo: fence.leaseNo },
        'Transcode heartbeat failed',
      );
      if (Date.now() - this.lastSuccess >= this.options.leaseMs) {
        this.markLost(`no successful heartbeat for ${this.options.leaseMs} ms`);
      }
    }
  }

  private markLost(reason: string): void {
    if (this.lost) return;
    this.lost = true;
    clearInterval(this.timer);
    this.options.onLost(reason);
  }
}
