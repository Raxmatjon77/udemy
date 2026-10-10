import { MEDIA_E2E_ENV } from '../../media/testing/apply-media-e2e-env';

/**
 * Side-effect import for the public-catalog e2e file: the shared e2e env (Swagger on,
 * Postgres, Redis) plus `S3_*` from `IT_S3_*` and the e2e readiness thresholds (1 lecture,
 * 0 s of video; design P2-T19). Import it FIRST.
 */
Object.assign(process.env, {
  CATALOG_SUBMIT_MIN_LECTURES: '1',
  CATALOG_SUBMIT_MIN_VIDEO_SECONDS: '0',
});

export const CATALOG_PUBLIC_E2E_ENV = MEDIA_E2E_ENV;
