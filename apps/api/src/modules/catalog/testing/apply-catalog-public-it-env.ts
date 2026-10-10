import { MEDIA_IT_ENV } from '../../media/testing/apply-media-it-env';

/**
 * Side-effect import for the public-catalog integration file: the media integration env
 * (Postgres, Redis, `S3_*` from `IT_S3_*`) plus the e2e readiness thresholds of design P2-T19
 * (1 lecture, 0 s of video), so a small published course is cheap to build. Import it FIRST.
 */
Object.assign(process.env, {
  CATALOG_SUBMIT_MIN_LECTURES: '1',
  CATALOG_SUBMIT_MIN_VIDEO_SECONDS: '0',
});

export const CATALOG_PUBLIC_IT_ENV = MEDIA_IT_ENV;
