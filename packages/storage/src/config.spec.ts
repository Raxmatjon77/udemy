import { describe, expect, it } from 'vitest';
import { storageConfigFromEnv, validateStorageConfig } from './config';
import { StorageConfigError } from './errors';

const ENV = {
  S3_ENDPOINT: 'http://localhost:9000',
  S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000/',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'minio',
  S3_SECRET_KEY: 'minio12345',
  S3_BUCKET_UPLOADS: 'udemy-uploads',
  S3_BUCKET_MEDIA: 'udemy-media',
  S3_FORCE_PATH_STYLE: 'true',
};

describe('storageConfigFromEnv', () => {
  it('reads the S3_* variables of .env.example', () => {
    expect(storageConfigFromEnv(ENV)).toEqual({
      endpoint: 'http://localhost:9000',
      publicEndpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      accessKeyId: 'minio',
      secretAccessKey: 'minio12345',
      forcePathStyle: true,
      buckets: { uploads: 'udemy-uploads', media: 'udemy-media' },
    });
  });

  it('defaults the public endpoint to S3_ENDPOINT and path-style to true', () => {
    const config = storageConfigFromEnv({
      ...ENV,
      S3_PUBLIC_ENDPOINT: undefined,
      S3_FORCE_PATH_STYLE: '',
    });
    expect(config.publicEndpoint).toBe('http://localhost:9000');
    expect(config.forcePathStyle).toBe(true);
    expect(storageConfigFromEnv({ ...ENV, S3_FORCE_PATH_STYLE: 'false' }).forcePathStyle).toBe(
      false,
    );
  });

  it.each([
    [{ S3_ENDPOINT: undefined }],
    [{ S3_SECRET_KEY: ' ' }],
    [{ S3_ENDPOINT: 'ftp://minio:21' }],
    [{ S3_ENDPOINT: 'http://minio:9000/base' }],
    [{ S3_PUBLIC_ENDPOINT: 'http://user:pw@minio:9000' }],
    [{ S3_BUCKET_MEDIA: 'udemy-uploads' }],
    [{ S3_BUCKET_UPLOADS: 'Bad_Bucket' }],
    [{ S3_FORCE_PATH_STYLE: 'yes' }],
  ])('rejects %o', (override) => {
    expect(() => storageConfigFromEnv({ ...ENV, ...override })).toThrow(StorageConfigError);
  });

  it('rejects non-positive timeouts', () => {
    const config = storageConfigFromEnv(ENV);
    expect(() => validateStorageConfig({ ...config, maxAttempts: 0 })).toThrow(StorageConfigError);
    expect(() => validateStorageConfig({ ...config, requestTimeoutMs: 1.5 })).toThrow(
      StorageConfigError,
    );
  });
});
