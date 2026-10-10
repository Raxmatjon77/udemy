import { StorageUnavailableError, type ObjectStorage } from '@udemy/storage';
import { describe, expect, it, vi } from 'vitest';
import { S3HealthIndicator } from './s3-health.indicator';

function indicator(ping: () => Promise<void>): S3HealthIndicator {
  return new S3HealthIndicator({ ping } as unknown as ObjectStorage);
}

describe('S3HealthIndicator', () => {
  it('is up when both buckets answer', async () => {
    const result = await indicator(async () => undefined).check('s3');
    expect(result).toEqual({ s3: { status: 'up', responseTimeMs: expect.any(Number) } });
  });

  it('is down (with a generic message) when S3 fails', async () => {
    const result = await indicator(async () => {
      throw new StorageUnavailableError({ operation: 'ping', bucket: 'udemy-uploads' });
    }).check('s3');
    expect(result).toEqual({ s3: { status: 'down', message: 'Object storage is unreachable' } });
  });

  it('is down when S3 does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      const pending = indicator(() => new Promise<void>(() => undefined)).check('s3', 50);
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toEqual({
        s3: { status: 'down', message: 'Object storage is unreachable' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
