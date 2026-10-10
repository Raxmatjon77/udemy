/**
 * A complete, valid api environment for tests (values mirror .env.example).
 * HTTP tests that import AppModule copy it into process.env inside `vi.hoisted`, before the
 * config module validates the environment.
 */
export const TEST_ENV = {
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  API_PUBLIC_URL: 'http://localhost:4000',
  JWT_AUDIENCE: 'udemy-api',
  JWT_KEYS_DIR: './.secrets/jwt',
  JWT_ACTIVE_KID: 'ed25519-2026-10',
  REFRESH_TOKEN_PEPPER: 'dev-refresh-token-pepper-change-me-in-prod-0000',
  LOGIN_EMAIL_HMAC_KEY: 'dev-login-email-hmac-key-change-me-in-prod-0000',
  CLIENT_STUDENT_SECRET_HASH: 'a53f56679c9a171d127e55ee0d0a5b4a37c713317c0c21a6144f26c4044ec441',
  CLIENT_INSTRUCTOR_SECRET_HASH: '3b7bb27be45a70680b0543f97491aa95dc64d9833e963bb31915d2510021d86a',
  CLIENT_ADMIN_SECRET_HASH: '139b0f73465c6df0c15b5b6b0d73e462984e5312bfb71020049aca12efd3cb82',
  // Phase 2 object storage: the dev compose MinIO (only the media tests actually call it).
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'minio',
  S3_SECRET_KEY: 'minio12345',
  S3_BUCKET_UPLOADS: 'udemy-uploads',
  S3_BUCKET_MEDIA: 'udemy-media',
} as const satisfies Record<string, string>;

/** Production-safe replacements for every dev placeholder in TEST_ENV. */
export const PRODUCTION_SECRETS = {
  REFRESH_TOKEN_PEPPER: 'p'.repeat(44),
  LOGIN_EMAIL_HMAC_KEY: 'k'.repeat(44),
  CLIENT_STUDENT_SECRET_HASH: '1'.repeat(64),
  CLIENT_INSTRUCTOR_SECRET_HASH: '2'.repeat(64),
  CLIENT_ADMIN_SECRET_HASH: '3'.repeat(64),
} as const;
