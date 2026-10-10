import { DependencyUnavailableError } from '@udemy/nest-common/errors';
import { describe, expect, it } from 'vitest';
import { RedisUnavailableError, withRedis } from './redis-unavailable.error';

describe('withRedis', () => {
  it('passes results through', async () => {
    await expect(withRedis(async () => 'PONG')).resolves.toBe('PONG');
  });

  it('wraps any failure, keeping the cause', async () => {
    const cause = new Error('Connection is closed.');

    const error: unknown = await withRedis(async () => {
      throw cause;
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(error).toBeInstanceOf(DependencyUnavailableError);
    expect(error).toMatchObject({ dependency: 'redis', cause });
  });
});
