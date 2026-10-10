import {
  baseEnvSchema,
  envBoolean,
  envInt,
  envList,
  envPort,
  refuseDevPlaceholdersInProduction,
} from '@udemy/nest-common';
import { mailEnvShape } from '@udemy/nest-common/mail';
import { z } from 'zod';

/** A positive count, or -1 for "let the broker decide". */
const brokerDefaultInt = z.coerce
  .number()
  .int()
  .refine((n) => n === -1 || n > 0, 'Expected -1 (broker default) or a positive integer');
const brokerAddress = z.string().regex(/^[^\s:]+:\d+$/, 'Expected host:port');

/** A bare web origin (`scheme://host[:port]`, no path), used as the base of links in emails. */
const appOrigin = z
  .url({ protocol: /^https?$/ })
  .refine(
    (value) => new URL(value).origin === value,
    'Expected an origin without path or trailing slash',
  );

/** Everything the worker reads from the environment. Validated once at startup. */
export const workerEnvSchema = baseEnvSchema
  .extend({
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

    // ---- Phase 1: identity emails (design §7, §9, D10)
    /**
     * HMAC key for the deterministic one-time email tokens (verify email / reset password).
     * Worker only; rotating it invalidates every outstanding link.
     */
    EMAIL_TOKEN_SECRET: z.string().min(32, 'Must be at least 32 characters'),
    /** SMTP_HOST, SMTP_PORT, MAIL_FROM (MailModule from @udemy/nest-common/mail). */
    ...mailEnvShape,
    /** Origins of the three Next apps; email links are built as `${origin}/verify-email#token=...`. */
    STUDENT_APP_ORIGIN: appOrigin,
    INSTRUCTOR_APP_ORIGIN: appOrigin,
    ADMIN_APP_ORIGIN: appOrigin,

    // ---- Phase 1: identity retention cleanup (schema doc §8)
    /** Run the scheduled cleanup in this replica (an advisory lock still makes runs exclusive). */
    IDENTITY_CLEANUP_ENABLED: envBoolean.default(true),
    /** Time between two cleanup runs. */
    IDENTITY_CLEANUP_INTERVAL_MS: envInt.min(10_000).default(60 * 60 * 1000),
    /** Delay of the first run after startup (lets the consumer join its group first). */
    IDENTITY_CLEANUP_INITIAL_DELAY_MS: envInt.default(60_000),
    /** Rows are deleted this many days after expiry / revocation. */
    IDENTITY_CLEANUP_GRACE_DAYS: envInt.max(365).default(7),
    /** Batch size for refresh and one-time tokens. */
    IDENTITY_CLEANUP_TOKEN_BATCH_SIZE: envInt.min(1).max(50_000).default(5_000),
    /** Batch size for sessions (each delete cascades to the session's tokens). */
    IDENTITY_CLEANUP_SESSION_BATCH_SIZE: envInt.min(1).max(50_000).default(500),
    /** Batch size for security_events older than 180 days. */
    IDENTITY_CLEANUP_SECURITY_EVENT_BATCH_SIZE: envInt.min(1).max(50_000).default(5_000),
    /** Upper bound of batches per statement and run, so one run can never loop forever. */
    IDENTITY_CLEANUP_MAX_BATCHES_PER_RUN: envInt.min(1).default(200),
  })
  // Refuse the `change-me` dev placeholders from .env.example when NODE_ENV=production.
  .superRefine(refuseDevPlaceholdersInProduction());

export type WorkerEnv = z.output<typeof workerEnvSchema>;
