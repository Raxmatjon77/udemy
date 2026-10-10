import {
  baseEnvSchema,
  envBoolean,
  envInt,
  envPort,
  refuseDevPlaceholdersInProduction,
} from '@udemy/nest-common';
import { type StorageConfig, validateStorageConfig } from '@udemy/storage';
import { z } from 'zod';

/** An executable: a bare name (resolved through PATH) or an absolute path. No arguments, no shell. */
const executable = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^(\/[^\0]+|[A-Za-z0-9._-]+)$/, 'Expected a bare program name or an absolute path');

/** An absolute directory path. */
const absoluteDir = z
  .string()
  .min(2)
  .max(1024)
  .regex(/^\/[^\0]*$/, 'Expected an absolute path')
  .refine((value) => value !== '/', 'Refusing the filesystem root');

const s3Endpoint = z.url({ protocol: /^https?$/ });
const nonEmpty = z.string().trim().min(1);

/**
 * Everything the transcoder reads from the environment (see `.env.example`, "Transcoder").
 * Validated once at startup; an invalid value fails the boot.
 */
export const transcoderEnvSchema = baseEnvSchema
  .extend({
    // ---- storage (`S3_*`, shared with the api and the worker)
    S3_ENDPOINT: s3Endpoint,
    /** Only used for presigning, which the transcoder never does; accepted for a shared .env. */
    S3_PUBLIC_ENDPOINT: s3Endpoint.optional(),
    S3_REGION: nonEmpty,
    S3_ACCESS_KEY: nonEmpty,
    S3_SECRET_KEY: nonEmpty,
    S3_BUCKET_UPLOADS: nonEmpty,
    S3_BUCKET_MEDIA: nonEmpty,
    /** Mandatory for MinIO (design §14). */
    S3_FORCE_PATH_STYLE: envBoolean.default(true),

    // ---- transcoder
    TRANSCODER_FFMPEG_PATH: executable.default('ffmpeg'),
    TRANSCODER_FFPROBE_PATH: executable.default('ffprobe'),
    /** Jobs run in parallel by one process (scale with replicas, not with this). */
    TRANSCODER_CONCURRENCY: envInt.min(1).max(16).default(1),
    /** Fallback poll when no `LISTEN media_transcode` notification arrives. */
    TRANSCODER_POLL_INTERVAL_MS: envInt.min(200).max(600_000).default(5_000),
    /** Lease length; heartbeats run every LEASE_MS / 3. */
    TRANSCODER_LEASE_MS: envInt.min(3_000).max(3_600_000).default(120_000),
    /** ffmpeg `-threads` (0 = let ffmpeg decide). */
    TRANSCODER_THREADS: envInt.max(64).default(0),
    /** Highest ladder rung (short side of the frame). */
    TRANSCODER_MAX_HEIGHT: envInt.min(360).max(2160).default(1080),
    /** Wall-clock limit = max(300 s, duration x factor). */
    TRANSCODER_TIMEOUT_FACTOR: z.coerce.number().min(0.5).max(100).default(4),
    /** Longer sources fail as TOO_LONG (poison). */
    TRANSCODER_MAX_SOURCE_SECONDS: envInt.min(1).max(86_400).default(14_400),
    /**
     * Attempts per job. The enqueuer writes media.transcode_jobs.max_attempts (DB default 3); the
     * transcoder additionally stops retrying once a job reached this many attempts.
     */
    TRANSCODER_MAX_ATTEMPTS: envInt.min(1).max(10).default(3),
    /** Scratch dir (source download + outputs); one sub-directory per attempt, always wiped. */
    TRANSCODER_TMP_DIR: absoluteDir.default('/tmp/udemy-transcoder'),
    /** /health/live and /health/ready. api 4000, worker 4001, transcoder 4002. */
    TRANSCODER_HEALTH_PORT: envPort.default(4002),
    /** Seek-preview sprite (thumbnails tiled 10x10 + WebVTT index). */
    TRANSCODER_SPRITES_ENABLED: envBoolean.default(true),
  })
  .superRefine((env, ctx) => {
    try {
      validateStorageConfig(storageConfigFromTranscoderEnv(env));
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ENDPOINT'],
        message: error instanceof Error ? error.message : 'Invalid S3 configuration',
      });
    }
  })
  // Refuse the `change-me` dev placeholders from .env.example when NODE_ENV=production.
  .superRefine(refuseDevPlaceholdersInProduction());

export type TranscoderEnv = z.output<typeof transcoderEnvSchema>;

type StorageEnvKeys =
  | 'S3_ENDPOINT'
  | 'S3_PUBLIC_ENDPOINT'
  | 'S3_REGION'
  | 'S3_ACCESS_KEY'
  | 'S3_SECRET_KEY'
  | 'S3_BUCKET_UPLOADS'
  | 'S3_BUCKET_MEDIA'
  | 'S3_FORCE_PATH_STYLE';

/** The `@udemy/storage` config of the validated env. */
export function storageConfigFromTranscoderEnv(
  env: Pick<TranscoderEnv, StorageEnvKeys>,
): StorageConfig {
  return {
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    buckets: { uploads: env.S3_BUCKET_UPLOADS, media: env.S3_BUCKET_MEDIA },
  };
}
