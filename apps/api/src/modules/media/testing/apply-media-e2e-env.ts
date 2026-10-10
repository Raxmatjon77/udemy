import { E2E_APP_ENV } from '../../../testing/e2e/apply-e2e-app-env';
import { itS3AppEnv } from './media-it';

/**
 * Side-effect import for the media e2e file: the shared e2e env (Swagger on, integration
 * Postgres/Redis) plus `S3_*` from `IT_S3_*`. Import it FIRST.
 */
Object.assign(process.env, itS3AppEnv());

export const MEDIA_E2E_ENV = E2E_APP_ENV;
