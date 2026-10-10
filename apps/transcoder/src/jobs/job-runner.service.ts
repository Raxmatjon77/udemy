import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { leaseTranscodeJob } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { TranscoderConfigService } from '../shared/config';
import { JobProcessor, type LeasedJob } from './job-processor';
import { JOB_SETTINGS, type JobSettings } from './job-settings';
import { LeaseReaper } from './lease-reaper';
import { TranscodeNotifier } from './transcode-notifier';

/** Upper bound for draining in-flight jobs on SIGTERM (compose stop_grace_period is 30 s). */
export const SHUTDOWN_DRAIN_MS = 25_000;
const MIN_REAPER_INTERVAL_MS = 5_000;

/**
 * The job loop: wakes on `NOTIFY media_transcode`, on every poll tick and whenever a job ends,
 * then leases until all TRANSCODER_CONCURRENCY slots are busy or nothing is due. The reaper runs
 * on its own timer. On shutdown: stop leasing, abort running jobs (ffmpeg gets SIGTERM, then
 * SIGKILL), release their leases without penalty, then let the pg pool close.
 */
@Injectable()
export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(JobRunner.name);
  private readonly active = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  private readonly notifier: TranscodeNotifier;
  private stopping = false;
  private pumping: Promise<void> | undefined;
  private pumpAgain = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private reaperTimer: NodeJS.Timeout | undefined;
  private reaping = false;

  constructor(
    @InjectDatabase() private readonly db: Database,
    private readonly processor: JobProcessor,
    private readonly reaper: LeaseReaper,
    @Inject(JOB_SETTINGS) private readonly settings: JobSettings,
    config: TranscoderConfigService,
  ) {
    this.notifier = new TranscodeNotifier({
      connectionString: config.get('DATABASE_URL'),
      applicationName: 'udemy-transcoder-listen',
      onNotify: () => this.wake(),
      logger: this.logger,
    });
  }

  onApplicationBootstrap(): void {
    this.logger.log(
      { workerId: this.settings.workerId, concurrency: this.settings.concurrency },
      'Transcoder job loop starting',
    );
    this.notifier.start();
    this.pollTimer = setInterval(() => this.wake(), this.settings.pollIntervalMs);
    this.reaperTimer = setInterval(
      () => void this.reap(),
      Math.max(MIN_REAPER_INTERVAL_MS, this.settings.pollIntervalMs),
    );
    void this.reap();
    this.wake();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.pollTimer);
    clearInterval(this.reaperTimer);
    await this.notifier.stop();
    await this.pumping;
    this.shutdown.abort();
    if (this.active.size === 0) return;
    this.logger.log({ jobs: this.active.size }, 'Releasing in-flight transcode jobs');
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.active]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Number of jobs currently running in this process. */
  get runningJobs(): number {
    return this.active.size;
  }

  get isListening(): boolean {
    return this.notifier.connected;
  }

  wake(): void {
    if (this.stopping) return;
    if (this.pumping !== undefined) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
    });
  }

  private async pump(): Promise<void> {
    do {
      this.pumpAgain = false;
      while (!this.stopping && this.active.size < this.settings.concurrency) {
        let lease;
        try {
          lease = await leaseTranscodeJob(this.db, {
            workerId: this.settings.workerId,
            leaseMs: this.settings.leaseMs,
          });
        } catch (error) {
          this.logger.warn(
            { err: error },
            'Leasing a transcode job failed; retrying on the next poll',
          );
          return;
        }
        if (lease === null) break;
        if (lease.kind === 'cancelled') {
          this.logger.log(
            { assetId: lease.assetId, leaseNo: lease.leaseNo },
            'Transcode job cancelled (asset purged or not processable)',
          );
          continue;
        }
        this.launch(lease);
      }
    } while (this.pumpAgain && !this.stopping);
  }

  private launch(lease: LeasedJob): void {
    const run = this.processor
      .run(lease, this.shutdown.signal)
      .then(
        () => undefined,
        (error: unknown) =>
          this.logger.error({ err: error, assetId: lease.assetId }, 'Transcode job crashed'),
      )
      .finally(() => {
        this.active.delete(run);
        this.wake();
      });
    this.active.add(run);
  }

  private async reap(): Promise<void> {
    if (this.reaping || this.stopping) return;
    this.reaping = true;
    try {
      await this.reaper.reapOnce();
    } catch (error) {
      this.logger.warn({ err: error }, 'Reaping expired transcode leases failed');
    } finally {
      this.reaping = false;
    }
  }
}
