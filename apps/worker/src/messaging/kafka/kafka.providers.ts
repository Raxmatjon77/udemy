/**
 * Kafka client choice: @confluentinc/kafka-javascript (not kafkajs).
 *
 * - kafkajs: pure JS and pleasant API, but unmaintained. Last release 2.2.4 was in Feb 2023,
 *   and it lags behind newer broker features.
 * - @confluentinc/kafka-javascript: Confluent's officially supported client, released
 *   regularly. It wraps librdkafka (the C client behind most Kafka clients: battle-tested,
 *   fast, full protocol support) and exposes a KafkaJS-compatible API under `KafkaJS`, so
 *   code and docs written for kafkajs mostly carry over.
 *   Cost: a native addon. Prebuilt binaries (glibc and musl, x64/arm64) are downloaded by its
 *   install script, which pnpm 10 only runs when allowed (onlyBuiltDependencies).
 *
 * Only files in this folder import the client, so the rest of the worker (and its tests)
 * never load the native binding.
 */
import { CODES, KafkaJS } from '@confluentinc/kafka-javascript';
import type { Provider } from '@nestjs/common';
import { WorkerConfigService } from '../../shared/config';
import { KafkaGroupMembership } from './kafka-group-membership';
import { createKafkaLogger } from './kafka-logger';

export const KAFKA_CONSUMER = Symbol('KAFKA_CONSUMER');
export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER');
export const KAFKA_ADMIN = Symbol('KAFKA_ADMIN');
export const KAFKA_MONITORING_ADMIN = Symbol('KAFKA_MONITORING_ADMIN');

function createKafka(config: WorkerConfigService): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: {
      brokers: config.get('KAFKA_BROKERS'),
      clientId: config.get('KAFKA_CLIENT_ID'),
      logger: createKafkaLogger(),
    },
  });
}

export const kafkaConsumerProvider: Provider = {
  provide: KAFKA_CONSUMER,
  inject: [WorkerConfigService, KafkaGroupMembership],
  useFactory: (config: WorkerConfigService, membership: KafkaGroupMembership): KafkaJS.Consumer =>
    createKafka(config).consumer({
      // Observe-only: returning nothing keeps the client's default (re)assignment logic.
      rebalance_cb: (err: KafkaJS.LibrdKafkaError): void => {
        if (err.code === CODES.ERRORS.ERR__ASSIGN_PARTITIONS) membership.markJoined();
      },
      kafkaJS: {
        groupId: config.get('KAFKA_GROUP_ID'),
        // How often librdkafka re-reads topic metadata (default 5 min). Safety net for a
        // subscribed topic that appears later and could not be pre-created (see kafka-topics.ts).
        metadataMaxAge: config.get('KAFKA_METADATA_MAX_AGE_MS'),
        // A new consumer group starts at the oldest retained message instead of skipping history.
        fromBeginning: true,
        // Offsets are committed only after eachMessage resolves, i.e. after the handler
        // committed its DB transaction or the message went to the DLQ (at-least-once).
        autoCommit: true,
      },
    }),
};

export const kafkaProducerProvider: Provider = {
  provide: KAFKA_PRODUCER,
  inject: [WorkerConfigService],
  useFactory: (config: WorkerConfigService): KafkaJS.Producer =>
    // Idempotent producer: broker-side dedup of retried sends, acks from all in-sync replicas.
    createKafka(config).producer({ kafkaJS: { idempotent: true } }),
};

/** Used once at startup to create missing topics (see kafka-topics.ts). */
export const kafkaAdminProvider: Provider = {
  provide: KAFKA_ADMIN,
  inject: [WorkerConfigService],
  useFactory: (config: WorkerConfigService): KafkaJS.Admin => createKafka(config).admin(),
};

/**
 * Long-lived, read-only admin client for the consumer lag metrics (offset and watermark lookups).
 * Separate from KAFKA_ADMIN, which ensureTopics connects and disconnects once at startup.
 */
export const kafkaMonitoringAdminProvider: Provider = {
  provide: KAFKA_MONITORING_ADMIN,
  inject: [WorkerConfigService],
  useFactory: (config: WorkerConfigService): KafkaJS.Admin => createKafka(config).admin(),
};
