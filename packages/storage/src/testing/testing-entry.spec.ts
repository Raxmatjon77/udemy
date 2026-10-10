import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as main from '../index';
import { isCi, itStorageConfig, PROBE_TIMEOUT_MS, useIntegrationS3 } from './index.mjs';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
  exports: Record<string, { types: string; default: string }>;
};

describe('@udemy/storage/testing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is a separate ESM subpath and not part of the main entry', () => {
    expect(pkg.exports['./testing']).toEqual({
      types: './dist/testing/index.d.mts',
      default: './dist/testing/index.mjs',
    });
    expect(Object.keys(main)).not.toContain('useIntegrationS3');
    expect(Object.keys(main)).not.toContain('itStorageConfig');
    expect(typeof useIntegrationS3).toBe('function');
    expect(PROBE_TIMEOUT_MS).toBe(25_000);
  });

  it('defaults to the dev compose MinIO', () => {
    for (const name of [
      'IT_S3_ENDPOINT',
      'IT_S3_PUBLIC_ENDPOINT',
      'IT_S3_REGION',
      'IT_S3_ACCESS_KEY',
      'IT_S3_SECRET_KEY',
      'IT_S3_BUCKET_UPLOADS',
      'IT_S3_BUCKET_MEDIA',
    ]) {
      vi.stubEnv(name, '');
    }
    expect(itStorageConfig()).toEqual({
      endpoint: 'http://localhost:9000',
      publicEndpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      accessKeyId: 'minio',
      secretAccessKey: 'minio12345',
      forcePathStyle: true,
      buckets: { uploads: 'udemy-uploads', media: 'udemy-media' },
      connectionTimeoutMs: 5_000,
      maxAttempts: 1,
    });
  });

  it('reads the IT_S3_* overrides (trimmed)', () => {
    vi.stubEnv('IT_S3_ENDPOINT', ' http://minio:9000 ');
    vi.stubEnv('IT_S3_BUCKET_MEDIA', 'media-ci');
    const config = itStorageConfig();
    expect(config.endpoint).toBe('http://minio:9000');
    expect(config.buckets.media).toBe('media-ci');
  });

  it('isCi follows CI=true only', () => {
    vi.stubEnv('CI', 'true');
    expect(isCi()).toBe(true);
    vi.stubEnv('CI', '1');
    expect(isCi()).toBe(false);
  });
});
