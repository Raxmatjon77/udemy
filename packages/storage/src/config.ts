import { StorageConfigError } from './errors';

/** Logical bucket roles. Physical names come from config; code never hard-codes them. */
export type BucketRole = 'uploads' | 'media';

export interface StorageConfig {
  /** Server-to-server S3 endpoint (`S3_ENDPOINT`), used for every network call. */
  endpoint: string;
  /**
   * Endpoint the browser calls (`S3_PUBLIC_ENDPOINT`), used only to presign URLs. SigV4 binds the
   * Host header, so a URL signed for `localhost:9000` fails with 403 SignatureDoesNotMatch when
   * the browser calls `127.0.0.1:9000` (verified in the T5 spike).
   */
  publicEndpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (`host/bucket/key`). Required for MinIO and for IP-literal endpoints. */
  forcePathStyle: boolean;
  buckets: {
    /** Quarantine bucket for raw user uploads (`S3_BUCKET_UPLOADS`). Never presigned for GET. */
    uploads: string;
    /** Processed outputs we serve (`S3_BUCKET_MEDIA`). */
    media: string;
  };
  /** TCP connect timeout. Default 3000 ms. */
  connectionTimeoutMs?: number;
  /** Socket inactivity timeout per request. Default 60000 ms. */
  requestTimeoutMs?: number;
  /** SDK attempts per call, including the first. Default 3. */
  maxAttempts?: number;
}

export type StorageEnv = Readonly<Record<string, string | undefined>>;

/**
 * Reads the `S3_*` variables (see `.env.example`):
 * `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` (defaults to `S3_ENDPOINT`), `S3_REGION`, `S3_ACCESS_KEY`,
 * `S3_SECRET_KEY`, `S3_BUCKET_UPLOADS`, `S3_BUCKET_MEDIA`, `S3_FORCE_PATH_STYLE` (default `true`).
 *
 * Apps with their own zod env schema can build a `StorageConfig` themselves and call
 * `validateStorageConfig` instead.
 */
export function storageConfigFromEnv(env: StorageEnv = process.env): StorageConfig {
  const endpoint = required(env, 'S3_ENDPOINT');
  return validateStorageConfig({
    endpoint,
    publicEndpoint: optional(env, 'S3_PUBLIC_ENDPOINT') ?? endpoint,
    region: required(env, 'S3_REGION'),
    accessKeyId: required(env, 'S3_ACCESS_KEY'),
    secretAccessKey: required(env, 'S3_SECRET_KEY'),
    forcePathStyle: parseBoolean(optional(env, 'S3_FORCE_PATH_STYLE'), 'S3_FORCE_PATH_STYLE', true),
    buckets: {
      uploads: required(env, 'S3_BUCKET_UPLOADS'),
      media: required(env, 'S3_BUCKET_MEDIA'),
    },
  });
}

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Checks a config and returns it with endpoints normalized (no trailing slash). */
export function validateStorageConfig(config: StorageConfig): StorageConfig {
  const endpoint = validateEndpoint(config.endpoint, 'endpoint');
  const publicEndpoint = validateEndpoint(config.publicEndpoint, 'publicEndpoint');
  for (const [name, value] of [
    ['region', config.region],
    ['accessKeyId', config.accessKeyId],
    ['secretAccessKey', config.secretAccessKey],
  ] as const) {
    if (value.trim() === '') throw new StorageConfigError(`Storage config: ${name} is empty`);
  }
  for (const role of ['uploads', 'media'] as const) {
    if (!BUCKET_NAME.test(config.buckets[role])) {
      throw new StorageConfigError(
        `Storage config: buckets.${role} "${config.buckets[role]}" is not a valid bucket name`,
      );
    }
  }
  // The "never presign GET on uploads" rule is enforced per role; one physical bucket for both
  // roles would silently defeat it.
  if (config.buckets.uploads === config.buckets.media) {
    throw new StorageConfigError('Storage config: the uploads and media buckets must differ');
  }
  for (const [name, value] of [
    ['connectionTimeoutMs', config.connectionTimeoutMs],
    ['requestTimeoutMs', config.requestTimeoutMs],
    ['maxAttempts', config.maxAttempts],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new StorageConfigError(`Storage config: ${name} must be a positive integer`);
    }
  }
  return { ...config, endpoint, publicEndpoint, buckets: { ...config.buckets } };
}

function validateEndpoint(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StorageConfigError(`Storage config: ${name} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StorageConfigError(`Storage config: ${name} must be http(s)`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
    throw new StorageConfigError(
      `Storage config: ${name} must be an origin (scheme://host[:port]) without path or credentials`,
    );
  }
  return url.origin;
}

function optional(env: StorageEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function required(env: StorageEnv, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new StorageConfigError(`${name} is required`);
  return value;
}

function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new StorageConfigError(`${name} must be true or false`);
}
