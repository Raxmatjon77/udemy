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

/** An S3 endpoint origin (`http(s)://host[:port]`); `@udemy/storage` validates it again. */
const s3Endpoint = z
  .url({ protocol: /^https?$/ })
  .refine(
    (value) => new URL(value).origin === value.replace(/\/+$/, ''),
    'Expected an origin without path',
  );

/** S3 bucket naming rules (as checked by `@udemy/storage`). */
const bucketName = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid bucket name');

/** `KAFKA_BROKERS`: comma-separated `host:port` list (shared with the worker CLI env). */
export const kafkaBrokersEnv = envList(brokerAddress).refine(
  (list) => list.length > 0,
  'At least one broker',
);

/** Optional origin (`http(s)://host[:port]`); an empty value counts as unset. */
const optionalOrigin = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .url({ protocol: /^https?$/ })
    .refine(
      (value) => new URL(value).origin === value.replace(/\/+$/, ''),
      'Expected an origin without path',
    )
    .transform((value) => value.replace(/\/+$/, ''))
    .optional(),
);

/** PostgreSQL identifier as used for replication slot names (`[a-z0-9_]`, at most 63 chars). */
const replicationSlotName = z
  .string()
  .regex(/^[a-z0-9_]{1,63}$/, 'Expected a replication slot name ([a-z0-9_], max 63)');

/** 0 disables; otherwise at least 5 s so the lag log cannot flood. */
const intervalOrOff = envInt.refine(
  (n) => n === 0 || n >= 5_000,
  'Expected 0 (disabled) or at least 5000 ms',
);

/**
 * Lower bound of PROCESSED_EVENTS_RETENTION_DAYS: one day more than the longest topic retention
 * of the dev/CI cluster (7 days: the PII topics and the broker default `log.retention.hours=168`).
 * See OutboxRetentionJob for why the dedupe window must outlive Kafka retention.
 */
export const MIN_PROCESSED_EVENTS_RETENTION_DAYS = 8;

/** Everything the worker reads from the environment. Validated once at startup. */
export const workerEnvSchema = baseEnvSchema
  .extend({
    /** Tiny HTTP server for k8s probes only (/health/live, /health/ready). Not PORT: the root .env sets that for the api. */
    WORKER_HEALTH_PORT: envPort.default(4001),
    KAFKA_BROKERS: kafkaBrokersEnv,
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

    // ---- Phase 2: object storage (design §3 `@udemy/storage`, §14). The worker only lists,
    // aborts and deletes (MediaCleanupJob); it never presigns.
    /** Server-to-server S3/MinIO endpoint (origin only). */
    S3_ENDPOINT: s3Endpoint,
    /** Endpoint presigned URLs are signed for. Unused by the worker; defaults to S3_ENDPOINT. */
    S3_PUBLIC_ENDPOINT: s3Endpoint.optional(),
    S3_REGION: z.string().trim().min(1),
    S3_ACCESS_KEY: z.string().trim().min(1),
    S3_SECRET_KEY: z.string().trim().min(1),
    /** Quarantine bucket of raw uploads (`uploads/{owner}/{asset}/source`). */
    S3_BUCKET_UPLOADS: bucketName,
    /** Processed outputs (`assets/{asset}/a{n}/...`). */
    S3_BUCKET_MEDIA: bucketName,
    /** Mandatory for MinIO (design §14). */
    S3_FORCE_PATH_STYLE: envBoolean.default(true),

    // ---- Phase 2: media cleanup (design §5 MediaCleanupJob A-D, schema doc §8.2)
    /** Run the scheduled media cleanup in this replica (an advisory lock still makes runs exclusive). */
    MEDIA_CLEANUP_ENABLED: envBoolean.default(true),
    /** Time between two media cleanup runs. */
    MEDIA_CLEANUP_INTERVAL_MS: envInt.min(10_000).default(60 * 60 * 1000),
    /** Delay of the first run after startup. */
    MEDIA_CLEANUP_INITIAL_DELAY_MS: envInt.default(120_000),
    /** Rows per batch transaction. Small: every purged asset also costs S3 deletes. */
    MEDIA_CLEANUP_BATCH_SIZE: envInt.min(1).max(1_000).default(100),
    /** Upper bound of batches per step and run. */
    MEDIA_CLEANUP_MAX_BATCHES_PER_RUN: envInt.min(1).default(50),
    /** A. UPLOADING assets older than this become ABORTED (multipart aborted in S3). */
    MEDIA_UPLOAD_TTL_HOURS: envInt
      .min(1)
      .max(24 * 3650)
      .default(24),
    /** C. Purge grace for never-attached assets. */
    MEDIA_UNATTACHED_GRACE_HOURS: envInt
      .min(1)
      .max(24 * 3650)
      .default(24),
    /** C. Purge grace after the last usage was released. */
    MEDIA_UNUSED_GRACE_DAYS: envInt.min(1).max(3650).default(7),
    /** D. Delete the uploaded original this many days after READY (decision Q5: 7; 1 in dev). */
    MEDIA_SOURCE_RETENTION_DAYS: envInt.min(0).max(3650).default(7),

    // ---- Phase 2: transcode enqueue (design D6, §14 P2-T12 follow-up)
    /**
     * Attempts per job before it fails for good, written to `media.transcode_jobs.max_attempts`
     * when the worker enqueues the job. Same variable, bounds and default as the transcoder
     * (`.env.example`); 1..10 (`MAX_TRANSCODE_ATTEMPTS_LIMIT` in `@udemy/db`).
     */
    TRANSCODER_MAX_ATTEMPTS: envInt.min(1).max(10).default(3),

    // ---- Phase 3: event pipeline operations (outbox retention, pipeline health, consumer lag)
    /** Run the scheduled outbox retention in this replica (an advisory lock still makes runs exclusive). */
    OUTBOX_RETENTION_ENABLED: envBoolean.default(true),
    /** Time between two outbox retention runs. */
    OUTBOX_RETENTION_INTERVAL_MS: envInt.min(10_000).default(60 * 60 * 1000),
    /** Delay of the first run after startup. */
    OUTBOX_RETENTION_INITIAL_DELAY_MS: envInt.default(180_000),
    /**
     * `outbox.events` rows older than this are deleted, but only once the replication slot has
     * confirmed them (see OutboxRetentionJob). The age floor only keeps recent rows for debugging.
     */
    OUTBOX_EVENTS_RETENTION_HOURS: envInt
      .min(1)
      .max(24 * 365)
      .default(72),
    /**
     * `outbox.processed_events` (the consumers' dedupe keys) older than this are deleted. Must be
     * longer than the retention of every consumed topic, so a redelivery can't slip past dedupe.
     */
    PROCESSED_EVENTS_RETENTION_DAYS: envInt
      .min(MIN_PROCESSED_EVENTS_RETENTION_DAYS)
      .max(3650)
      .default(30),
    /** Rows per delete batch (one transaction each). */
    OUTBOX_RETENTION_BATCH_SIZE: envInt.min(1).max(50_000).default(5_000),
    /** Upper bound of batches per table and run. */
    OUTBOX_RETENTION_MAX_BATCHES_PER_RUN: envInt.min(1).default(100),
    /** Debezium's logical replication slot (`slot.name` in infra/debezium/outbox-connector.json). */
    OUTBOX_REPLICATION_SLOT: replicationSlotName.default('udemy_outbox'),
    /** Kafka Connect REST API for the readiness "pipeline" detail. Unset: connector check skipped. */
    KAFKA_CONNECT_URL: optionalOrigin,
    /** Name of the Debezium outbox connector in Kafka Connect. */
    DEBEZIUM_CONNECTOR_NAME: z.string().trim().min(1).default('udemy-outbox'),
    /** How often the consumer lag of the handled topics is logged. 0 = off. */
    PIPELINE_METRICS_INTERVAL_MS: intervalOrOff.default(60_000),

    // ---- Phase 4: enrollment mail and the payouts ledger (design §7, D13, schema doc §8.7)
    /** `enrollment.instructor-new-enrollment-mailer` sends mail only when true (events are consumed either way). */
    ENROLLMENT_INSTRUCTOR_MAIL_ENABLED: envBoolean.default(false),
    /** Run the scheduled ledger reconciliation in this replica (an advisory lock still makes runs exclusive). */
    LEDGER_RECONCILIATION_ENABLED: envBoolean.default(true),
    /** Time between two reconciliation runs. */
    LEDGER_RECONCILIATION_INTERVAL_MS: envInt.min(60_000).default(60 * 60 * 1000),
    /** Delay of the first run after startup. */
    LEDGER_RECONCILIATION_INITIAL_DELAY_MS: envInt.default(240_000),
    /**
     * Only commerce facts older than this are reconciled (orders paid / refunds succeeded before
     * now - N min), so events still in flight through Debezium and Kafka are not reported.
     */
    LEDGER_RECONCILIATION_SETTLE_MINUTES: envInt
      .min(1)
      .max(7 * 24 * 60)
      .default(60),
  })
  // Refuse the `change-me` dev placeholders from .env.example when NODE_ENV=production.
  .superRefine(refuseDevPlaceholdersInProduction());

export type WorkerEnv = z.output<typeof workerEnvSchema>;
