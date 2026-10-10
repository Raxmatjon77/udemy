import type { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { WorkerConfigService } from '../../shared/config';
import { EventHandlerRegistry } from '../event-handler.registry';
import { fetchConsumerLag, type TopicLag } from './consumer-lag';
import { KAFKA_MONITORING_ADMIN } from './kafka.providers';

export interface ConsumerLagSnapshot {
  readonly at: string;
  readonly groupId: string;
  readonly totalLag: number;
  readonly topics: readonly TopicLag[];
}

/**
 * Logs the consumer lag of every handled topic every PIPELINE_METRICS_INTERVAL_MS (0 = off):
 * one `Consumer lag` line per topic (`topic`, `lag`, per-partition committed / high watermark),
 * at warn level once a topic's lag reaches the threshold below. Each replica logs the same group
 * lag; aggregate by `topic` and take the latest, not the sum.
 *
 * The latest sample is kept for the readiness "pipeline" detail.
 */
@Injectable()
export class ConsumerLagReporter implements OnApplicationBootstrap, BeforeApplicationShutdown {
  /** A topic with at least this many unconsumed messages is logged at warn level. */
  static readonly WARN_LAG = 1_000;

  private readonly logger = new Logger(ConsumerLagReporter.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private connected: Promise<void> | undefined;
  private stopping = false;
  private last: ConsumerLagSnapshot | undefined;

  constructor(
    @Inject(KAFKA_MONITORING_ADMIN) private readonly admin: KafkaJS.Admin,
    private readonly registry: EventHandlerRegistry,
    private readonly config: WorkerConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = this.config.get('PIPELINE_METRICS_INTERVAL_MS');
    if (intervalMs === 0) {
      this.logger.log('Consumer lag metrics disabled (PIPELINE_METRICS_INTERVAL_MS=0)');
      return;
    }
    if (this.registry.topics().length === 0) return;
    this.timer = setInterval(() => this.trigger(), intervalMs);
    // Never keep the process alive just for metrics.
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
    if (this.connected === undefined) return;
    try {
      await this.connected;
      await this.admin.disconnect();
    } catch (error) {
      this.logger.warn({ err: error }, 'Kafka monitoring admin did not disconnect cleanly');
    }
  }

  /** The most recent sample (undefined before the first one). */
  lastSnapshot(): ConsumerLagSnapshot | undefined {
    return this.last;
  }

  private trigger(): void {
    if (this.stopping || this.running !== undefined) return;
    this.running = this.sample()
      .then(() => undefined)
      .catch((error: unknown) => this.logger.warn({ err: error }, 'Consumer lag sample failed'))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** Takes and logs one sample. Public for tests and manual runs. */
  async sample(): Promise<ConsumerLagSnapshot> {
    if (this.connected === undefined) {
      this.connected = this.admin.connect().catch((error: unknown) => {
        this.connected = undefined; // retry on the next tick
        throw error;
      });
    }
    await this.connected;

    const groupId = this.config.get('KAFKA_GROUP_ID');
    const topics = await fetchConsumerLag(this.admin, groupId, this.registry.topics());
    let totalLag = 0;
    for (const t of topics) {
      if ('error' in t) {
        this.logger.warn({ groupId, topic: t.topic, error: t.error }, 'Consumer lag unavailable');
        continue;
      }
      totalLag += t.lag;
      const context = { groupId, topic: t.topic, lag: t.lag, partitions: t.partitions };
      if (t.lag >= ConsumerLagReporter.WARN_LAG) this.logger.warn(context, 'Consumer lag');
      else this.logger.log(context, 'Consumer lag');
    }
    this.last = { at: new Date().toISOString(), groupId, totalLag, topics };
    return this.last;
  }
}
