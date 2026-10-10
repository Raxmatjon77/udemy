/**
 * `@udemy/storage/testing`: the MinIO integration-test harness (vitest). ESM-only, test code only;
 * never import it from application code (the main `@udemy/storage` entry does not include it).
 */
export type { IntegrationS3, SkippableContext, UseIntegrationS3Options } from './it-s3.mjs';
export { isCi, itStorageConfig, PROBE_TIMEOUT_MS, useIntegrationS3 } from './it-s3.mjs';
