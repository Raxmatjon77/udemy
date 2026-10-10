import { describe, expect, it } from 'vitest';
import { storageConfigFromEnv } from './config';
import { StorageUnavailableError, StorageUsageError } from './errors';
import { ObjectStorage } from './object-storage';
import { MiB } from './part-plan';

// Presigning is local HMAC (no network), so these run without MinIO.
const config = storageConfigFromEnv({
  S3_ENDPOINT: 'http://minio.internal:9000',
  S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'minio',
  S3_SECRET_KEY: 'minio12345',
  S3_BUCKET_UPLOADS: 'udemy-uploads',
  S3_BUCKET_MEDIA: 'udemy-media',
});
const storage = new ObjectStorage(config);
const KEY =
  'uploads/0b8e2c1a-1111-4a2b-8c3d-000000000001/7d4f9e2b-2222-4c5d-9e6f-000000000002/source';

describe('presignUploadPart', () => {
  it('signs content-length and host, path-style on the PUBLIC endpoint, with no checksum params', async () => {
    const before = Date.now();
    const signed = await storage.presignUploadPart({
      bucket: 'uploads',
      key: KEY,
      uploadId: 'upload-1',
      partNumber: 3,
      contentLength: 8 * MiB,
      ttlSeconds: 900,
    });
    const url = new URL(signed.url);
    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(url.pathname).toBe(`/udemy-uploads/${KEY}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('upload-1');
    // Regression guard for the SDK's WHEN_SUPPORTED default (see s3-clients.ts).
    expect([...url.searchParams.keys()].filter((k) => /checksum/i.test(k))).toEqual([]);
    expect(signed.contentLength).toBe(8 * MiB);
    expect(signed.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 900_000);
    expect(signed.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 900_000);
  });

  it.each([
    [{ partNumber: 0 }],
    [{ partNumber: 10_001 }],
    [{ contentLength: 0 }],
    [{ contentLength: 5 * 1024 * MiB + 1 }],
    [{ ttlSeconds: 0 }],
    [{ ttlSeconds: 604_801 }],
    [{ uploadId: '' }],
    [{ key: '' }],
    [{ key: '/abs' }],
    [{ key: 'a\nb' }],
  ])('rejects %o', async (override) => {
    await expect(
      storage.presignUploadPart({
        bucket: 'uploads',
        key: KEY,
        uploadId: 'u',
        partNumber: 1,
        contentLength: 10,
        ttlSeconds: 60,
        ...override,
      }),
    ).rejects.toThrow(StorageUsageError);
  });
});

describe('presignGet', () => {
  it('signs a media GET with response overrides on the public endpoint', async () => {
    const signed = await storage.presignGet({
      bucket: 'media',
      key: 'assets/x/a1/resource',
      ttlSeconds: 300,
      responseContentType: 'application/octet-stream',
      responseContentDisposition: 'attachment; filename="a.pdf"',
    });
    const url = new URL(signed.url);
    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(url.pathname).toBe('/udemy-media/assets/x/a1/resource');
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="a.pdf"',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('refuses to presign a GET on the uploads bucket', async () => {
    await expect(
      storage.presignGet({ bucket: 'uploads' as 'media', key: KEY, ttlSeconds: 60 }),
    ).rejects.toThrow(/Refusing to presign a GET on the "uploads" bucket/);
    await expect(
      // A physical bucket name is not a role either.
      storage.presignGet({ bucket: 'udemy-uploads' as 'media', key: KEY, ttlSeconds: 60 }),
    ).rejects.toThrow(StorageUsageError);
  });

  it('rejects header injection in response overrides', async () => {
    await expect(
      storage.presignGet({
        bucket: 'media',
        key: 'assets/x',
        ttlSeconds: 60,
        responseContentDisposition: 'attachment\r\nX-Evil: 1',
      }),
    ).rejects.toThrow(StorageUsageError);
  });
});

describe('connection failures', () => {
  it('surface as StorageUnavailableError (DependencyUnavailableError "s3")', async () => {
    const dead = new ObjectStorage({
      ...config,
      endpoint: 'http://127.0.0.1:1',
      maxAttempts: 1,
      connectionTimeoutMs: 2_000,
    });
    try {
      const error = await dead.headObject({ bucket: 'media', key: 'x' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StorageUnavailableError);
      expect((error as StorageUnavailableError).dependency).toBe('s3');
      expect((error as StorageUnavailableError).operation).toBe('headObject');
    } finally {
      dead.destroy();
    }
  });
});
