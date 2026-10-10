import { isAbsolute, resolve } from 'node:path';
import { type ClientApp, COURSE_SUBMISSION_DEFAULTS } from '@udemy/contracts';
import {
  baseEnvSchema,
  envBoolean,
  envInt,
  envList,
  envPort,
  refuseDevPlaceholdersInProduction,
} from '@udemy/nest-common';
import { z } from 'zod';
import { API_ROOT_DIR } from './api-root-dir';

/** Lowercase hex SHA-256 of a BFF client secret (`printf '%s' "$SECRET" | openssl dgst -sha256`). */
const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Expected 64 lowercase hex characters (SHA-256)');

/** HMAC keys / peppers: high-entropy secrets (`openssl rand -base64 32` gives 44 chars). */
const hmacSecret = z.string().min(32, 'Must be at least 32 characters');

/** An http(s) origin without path, query or credentials (SigV4 binds the host). */
const s3Endpoint = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = new URL(value);
  return url.pathname === '/' && url.search === '' && url.username === '' && url.hash === '';
}, 'Expected an origin (scheme://host[:port]) without path or credentials');

/** S3 bucket naming rules (lowercase, 3-63 chars). */
const bucketName = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid bucket name');

/** Presigned URL lifetime in seconds: SigV4 allows at most 7 days. */
const presignTtl = envInt.min(1).max(604_800);

/** A positive byte count that stays a safe integer. */
const byteCount = envInt.min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * `ed25519-YYYY-MM`, optionally with a suffix for a second key in the same month
 * (`ed25519-2026-10-b`, emergency rotation). It is also a file name, so the charset is strict.
 */
const JWT_KID_FORMAT = /^ed25519-\d{4}-(?:0[1-9]|1[0-2])(?:-[a-z0-9]+)?$/;

/**
 * SHA-256 of the dev BFF secrets in apps/web-*\/.env.example. They cannot contain the
 * `change-me` marker, so production refuses them explicitly.
 */
export const DEV_CLIENT_SECRET_HASHES = [
  'a53f56679c9a171d127e55ee0d0a5b4a37c713317c0c21a6144f26c4044ec441',
  '3b7bb27be45a70680b0543f97491aa95dc64d9833e963bb31915d2510021d86a',
  '139b0f73465c6df0c15b5b6b0d73e462984e5312bfb71020049aca12efd3cb82',
] as const;

/** Env key of each BFF's client-secret hash. */
export const CLIENT_SECRET_HASH_KEYS = {
  student: 'CLIENT_STUDENT_SECRET_HASH',
  instructor: 'CLIENT_INSTRUCTOR_SECRET_HASH',
  admin: 'CLIENT_ADMIN_SECRET_HASH',
} as const satisfies Record<ClientApp, string>;

/** Everything the api process reads from the environment. Validated once at startup. */
export const apiEnvSchema = baseEnvSchema
  .extend({
    PORT: envPort.default(4000),
    /** Browser origins allowed by CORS, comma separated. Empty = no cross-origin access. */
    CORS_ORIGINS: envList(z.url()).default([]),
    /** Number of reverse proxies in front of the app (ingress, LB); 0 = none. Drives req.ip. */
    TRUST_PROXY_HOPS: envInt.default(1),
    SWAGGER_ENABLED: envBoolean.default(true),
    /** Global rate limit: THROTTLE_LIMIT requests per THROTTLE_TTL_MS per client IP. */
    THROTTLE_TTL_MS: envInt.min(1).default(60_000),
    THROTTLE_LIMIT: envInt.min(1).default(300),

    // ---- Phase 1: identity & access (design §9)
    /** Revocation keys, rate-limit counters. Fail-closed dependency (design D11). */
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    /** JWT `iss`. Compared verbatim with the BFFs' JWT_ISSUER, so it is not normalised. */
    API_PUBLIC_URL: z.url({ protocol: /^https?$/ }),
    /** JWT `aud`. Must equal the BFFs' JWT_AUDIENCE. */
    JWT_AUDIENCE: z.string().trim().min(1),
    /** Directory of `<kid>.pem` Ed25519 keys. Relative paths resolve against apps/api; absolute output. */
    JWT_KEYS_DIR: z
      .string()
      .min(1)
      .transform((dir) => (isAbsolute(dir) ? dir : resolve(API_ROOT_DIR, dir))),
    /** kid of the signing key; `<JWT_ACTIVE_KID>.pem` must exist in JWT_KEYS_DIR (checked by the KeyStore, T7). */
    JWT_ACTIVE_KID: z.string().regex(JWT_KID_FORMAT, 'Expected ed25519-YYYY-MM[-suffix]'),
    /** HMAC pepper of refresh-token hashes. Rotating it logs everyone out. */
    REFRESH_TOKEN_PEPPER: hmacSecret,
    /** HMAC key for login rate-limit keys and security_events.email_hash. */
    LOGIN_EMAIL_HMAC_KEY: hmacSecret,
    /** Per-BFF client credentials: only the SHA-256 of each secret is configured. */
    CLIENT_STUDENT_SECRET_HASH: sha256Hex,
    CLIENT_INSTRUCTOR_SECRET_HASH: sha256Hex,
    CLIENT_ADMIN_SECRET_HASH: sha256Hex,

    // ---- Phase 2: object storage (S3 / MinIO), read by @udemy/storage (design §3, §14)
    /** Server-to-server S3 endpoint (origin only). */
    S3_ENDPOINT: s3Endpoint,
    /** Endpoint browsers call; presigned URLs are signed for it. Defaults to S3_ENDPOINT. */
    S3_PUBLIC_ENDPOINT: s3Endpoint.optional(),
    S3_REGION: z.string().trim().min(1),
    S3_ACCESS_KEY: z.string().trim().min(1),
    S3_SECRET_KEY: z.string().trim().min(1),
    /** Quarantine bucket for raw uploads (never presigned for GET). */
    S3_BUCKET_UPLOADS: bucketName,
    /** Processed outputs served through presigned GETs. */
    S3_BUCKET_MEDIA: bucketName,
    /** Mandatory for MinIO (no MINIO_DOMAIN, design §14). */
    S3_FORCE_PATH_STYLE: envBoolean.default(true),

    // ---- Phase 2: media (design §4, §9)
    MEDIA_PART_URL_TTL_S: presignTtl.default(900),
    MEDIA_PLAYBACK_URL_TTL_S: presignTtl.default(3600),
    MEDIA_IMAGE_URL_TTL_S: presignTtl.default(3600),
    MEDIA_DOWNLOAD_URL_TTL_S: presignTtl.default(300),
    /** Max declared size per purpose (bytes); can only lower the contracts' MEDIA_PURPOSE_RULES. */
    MEDIA_MAX_VIDEO_BYTES: byteCount.default(4 * 1024 ** 3),
    MEDIA_MAX_IMAGE_BYTES: byteCount.default(5 * 1024 ** 2),
    MEDIA_MAX_RESOURCE_BYTES: byteCount.default(100 * 1024 ** 2),
    /** Σ declared sizes of an owner's live assets. */
    MEDIA_QUOTA_BYTES_PER_OWNER: byteCount.default(100 * 1024 ** 3),
    /** Max UPLOADING assets per owner. */
    MEDIA_MAX_CONCURRENT_UPLOADS: envInt.min(1).max(100).default(5),

    // ---- Phase 2: catalog readiness thresholds (design §4 invariant 6, §13 Q6; dev/e2e: 1 / 0)
    /** Minimum number of lectures a course needs before it can be submitted. */
    CATALOG_SUBMIT_MIN_LECTURES: envInt
      .min(0)
      .max(500)
      .default(COURSE_SUBMISSION_DEFAULTS.minLectures),
    /** Minimum total READY video duration (seconds) before submission. */
    CATALOG_SUBMIT_MIN_VIDEO_SECONDS: envInt
      .min(0)
      .max(1_000_000)
      .default(COURSE_SUBMISSION_DEFAULTS.minVideoSeconds),
  })
  .superRefine((env, ctx) => {
    // Shared secrets would silently couple unrelated security properties.
    if (env.REFRESH_TOKEN_PEPPER === env.LOGIN_EMAIL_HMAC_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOGIN_EMAIL_HMAC_KEY'],
        message: 'Must differ from REFRESH_TOKEN_PEPPER',
      });
    }
    // "Never presign GET on uploads" is enforced per bucket role; one bucket would defeat it.
    if (env.S3_BUCKET_UPLOADS === env.S3_BUCKET_MEDIA) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_BUCKET_MEDIA'],
        message: 'Must differ from S3_BUCKET_UPLOADS',
      });
    }
    // Two BFFs with the same secret could act as each other's app, breaking app confinement (D6).
    const seen = new Map<string, string>();
    for (const key of Object.values(CLIENT_SECRET_HASH_KEYS)) {
      const other = seen.get(env[key]);
      if (other !== undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: `Must differ from ${other}` });
      }
      seen.set(env[key], key);
    }
  })
  .superRefine(refuseDevPlaceholdersInProduction({ forbiddenValues: DEV_CLIENT_SECRET_HASHES }));

export type ApiEnv = z.output<typeof apiEnvSchema>;
