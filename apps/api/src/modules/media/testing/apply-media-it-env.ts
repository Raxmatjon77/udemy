import { IT_APP_ENV } from '../../../testing/apply-it-app-env';
import { itS3AppEnv } from './media-it';

/**
 * Side-effect import for media integration tests that boot the real AppModule: everything
 * `apply-it-app-env` does (integration Postgres/Redis, a throwaway signing key), plus the
 * `S3_*` variables from `IT_S3_*` and small media limits so quota and concurrency are cheap to
 * reach. Import it FIRST (AppModule validates process.env when it is imported).
 */
export const MEDIA_IT_LIMITS = {
  quotaBytes: 200 * 1024 * 1024,
  maxConcurrentUploads: 3,
} as const;

Object.assign(process.env, itS3AppEnv(), {
  MEDIA_QUOTA_BYTES_PER_OWNER: String(MEDIA_IT_LIMITS.quotaBytes),
  MEDIA_MAX_CONCURRENT_UPLOADS: String(MEDIA_IT_LIMITS.maxConcurrentUploads),
});

export const MEDIA_IT_ENV = IT_APP_ENV;
