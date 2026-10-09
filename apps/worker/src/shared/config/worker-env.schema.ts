import { baseEnvSchema, envInt, envList, envPort } from '@udemy/nest-common';
import { z } from 'zod';

/** A positive count, or -1 for "let the broker decide". */
const brokerDefaultInt = z.coerce
  .number()
  .int()
  .refine((n) => n === -1 || n > 0, 'Expected -1 (broker default) or a positive integer');
const brokerAddress = z.string().regex(/^[^\s:]+:\d+$/, 'Expected host:port');

/** Everything the worker reads from the environment. Validated once at startup. */
export const workerEnvSchema = baseEnvSchema.extend({
  /** Tiny HTTP server for k8s probes only (/health/live, /health/ready). Not PORT: the root .env sets that for the api. */
  WORKER_HEALTH_PORT: envPort.default(4001),
  KAFKA_BROKERS: envList(brokerAddress).refine((list) => list.length > 0, 'At least one broker'),
  KAFKA_CLIENT_ID: z.string().min(1).default('udemy-worker'),
  /** All worker replicas share this group, so each partition is consumed by one replica. */
  KAFKA_GROUP_ID: z.string().min(1).default('udemy-worker'),
  /** Settings for topics the worker creates at startup (handler topics + DLQs). -1 = broker default. */
  KAFKA_TOPIC_PARTITIONS: brokerDefaultInt.default(-1),
  KAFKA_TOPIC_REPLICATION_FACTOR: brokerDefaultInt.default(-1),
  /** librdkafka topic.metadata.refresh.interval.ms: how soon a newly created topic is noticed. */
  KAFKA_METADATA_MAX_AGE_MS: envInt.min(1_000).default(30_000),
  /** In-process retries per handler before the message goes to `<topic>.dlq`. */
  WORKER_MAX_RETRIES: envInt.max(10).default(3),
  WORKER_RETRY_BASE_DELAY_MS: envInt.min(1).default(200),
  WORKER_RETRY_MAX_DELAY_MS: envInt.min(1).default(5_000),
});

export type WorkerEnv = z.output<typeof workerEnvSchema>;
