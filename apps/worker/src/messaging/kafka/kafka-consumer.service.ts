import type { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { InboundRecord } from '../envelope/inbound-record';
import { EventHandlerRegistry } from '../event-handler.registry';
import { WorkerConfigService } from '../../shared/config';
import { MessageDispatcher } from '../message-dispatcher';
import { KafkaGroupMembership } from './kafka-group-membership';
import { ensureTopics } from './kafka-topics';
import { KAFKA_ADMIN, KAFKA_CONSUMER, KAFKA_PRODUCER } from './kafka.providers';

function toInboundRecord(
  topic: string,
  partition: number,
  message: KafkaJS.KafkaMessage,
): InboundRecord {
  return {
    topic,
    partition,
    offset: message.offset,
    key: message.key,
    value: message.value,
    headers: message.headers ?? {},
    timestamp: message.timestamp,
  };
}

/**
 * Owns the Kafka connections. Startup: create missing topics -> producer (for the DLQ) ->
 * consumer -> subscribe to every topic that has a handler -> run. Shutdown runs in reverse, and before the DB pool
 * closes (beforeApplicationShutdown precedes onApplicationShutdown).
 *
 * Startup does not block Nest's bootstrap: librdkafka keeps retrying an unreachable broker,
 * and the health server must still come up so k8s sees "alive but not ready" instead of a
 * dead pod. If connecting fails outright, the worker shuts itself down and k8s restarts it.
 */
@Injectable()
export class KafkaConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private state: 'idle' | 'starting' | 'running' | 'stopping' = 'idle';

  constructor(
    @Inject(KAFKA_CONSUMER) private readonly consumer: KafkaJS.Consumer,
    @Inject(KAFKA_PRODUCER) private readonly producer: KafkaJS.Producer,
    @Inject(KAFKA_ADMIN) private readonly admin: KafkaJS.Admin,
    private readonly registry: EventHandlerRegistry,
    private readonly dispatcher: MessageDispatcher,
    private readonly membership: KafkaGroupMembership,
    private readonly config: WorkerConfigService,
  ) {}

  /** For the readiness probe: undefined when ready, otherwise why not. */
  notReadyReason(): string | undefined {
    if (this.state !== 'running') return `Kafka consumer is ${this.state}`;
    if (!this.membership.hasJoined()) return 'Kafka consumer has not joined its group yet';
    return undefined;
  }

  onApplicationBootstrap(): void {
    const topics = this.registry.topics();
    if (topics.length === 0) {
      this.logger.warn('No @EventHandler registered; the consumer is not started');
      return;
    }
    this.state = 'starting';
    void this.start(topics).catch((error: unknown) => {
      if (this.state === 'stopping') return;
      this.logger.fatal({ err: error }, 'Kafka consumer failed to start, shutting down');
      // Same path as `kubectl delete pod`: graceful shutdown hooks, then exit.
      process.kill(process.pid, 'SIGTERM');
    });
  }

  private async start(topics: string[]): Promise<void> {
    await this.ensureTopics(topics);
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topics });
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) =>
        this.dispatcher.dispatch(toInboundRecord(topic, partition, message)),
    });
    if (this.state !== 'starting') return; // shutdown began while we were connecting
    this.state = 'running';
    this.logger.log(`Consuming ${topics.join(', ')}`);
  }

  /**
   * Not fatal: without CREATE permission (e.g. a locked-down prod cluster) topics come from
   * ops/Debezium, and the short metadata refresh picks them up once they exist.
   */
  private async ensureTopics(topics: string[]): Promise<void> {
    try {
      const ensured = await ensureTopics(this.admin, topics, {
        numPartitions: this.config.get('KAFKA_TOPIC_PARTITIONS'),
        replicationFactor: this.config.get('KAFKA_TOPIC_REPLICATION_FACTOR'),
      });
      this.logger.log(`Topics ensured: ${ensured.join(', ')}`);
    } catch (error) {
      this.logger.error(
        { err: error },
        'Could not create missing topics; relying on metadata refresh',
      );
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.state === 'idle') return;
    this.state = 'stopping';
    // 1. Cut short any backoff sleep; that message stays uncommitted and is redelivered.
    this.dispatcher.abort();
    // 2. Leave the group (lets the in-flight message finish, commits offsets).
    await this.disconnectQuietly('consumer', this.consumer);
    // 3. Only now close the producer: a final DLQ publish may still have needed it.
    await this.disconnectQuietly('producer', this.producer);
    this.logger.log('Kafka consumer stopped');
  }

  private async disconnectQuietly(
    name: string,
    client: { disconnect(): Promise<void> },
  ): Promise<void> {
    try {
      await client.disconnect();
    } catch (error) {
      // E.g. it never finished connecting. Shutdown must go on regardless.
      this.logger.warn({ err: error }, `Kafka ${name} did not disconnect cleanly`);
    }
  }
}
