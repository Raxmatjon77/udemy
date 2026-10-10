import { describe, expect, it, vi } from 'vitest';
import type { RedisClient } from './redis.constants';
import { RedisHealthIndicator } from './redis-health.indicator';

function indicator(status: string, ping: () => Promise<string>): RedisHealthIndicator {
  return new RedisHealthIndicator({ status, ping: vi.fn(ping) } as unknown as RedisClient);
}

describe('RedisHealthIndicator', () => {
  it('is up when connected and PING answers', async () => {
    const result = await indicator('ready', async () => 'PONG').check('redis');
    expect(result).toMatchObject({ redis: { status: 'up', responseTimeMs: expect.any(Number) } });
  });

  it('is down while (re)connecting, without sending a command', async () => {
    const ping = vi.fn(async () => 'PONG');
    const health = new RedisHealthIndicator({
      status: 'reconnecting',
      ping,
    } as unknown as RedisClient);

    expect(await health.check('redis')).toEqual({
      redis: { status: 'down', message: 'Redis is unreachable' },
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it('is down when PING fails', async () => {
    const result = await indicator('ready', async () => {
      throw new Error('Command timed out');
    }).check('redis');
    expect(result).toEqual({ redis: { status: 'down', message: 'Redis is unreachable' } });
  });
});
