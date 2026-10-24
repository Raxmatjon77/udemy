import { Injectable } from '@nestjs/common';
import { InjectRedis, type RedisClient, withRedis } from '../../../../shared/redis';
import { SessionRevocationStore } from '../../application/ports/session-revocation.store';
import { SESSION_REVOCATION_TTL_SECONDS } from '../../domain/access-token';

/** Keys per MGET of `revokedAmong` (bounds one command; a replica holds a few thousand sockets). */
export const REVOKED_AMONG_BATCH_SIZE = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `auth:revoked:sid:{sid}` (design §6 "Redis keys"). */
export function revokedSessionKey(sessionId: string): string {
  if (!UUID.test(sessionId)) throw new TypeError('Session id must be a UUID');
  return `auth:revoked:sid:${sessionId.toLowerCase()}`;
}

/** Redis-backed revocation list; every call goes through `withRedis` (fail closed -> 503). */
@Injectable()
export class RedisSessionRevocationStore extends SessionRevocationStore {
  constructor(@InjectRedis() private readonly redis: RedisClient) {
    super();
  }

  async revoke(sessionId: string): Promise<void> {
    const key = revokedSessionKey(sessionId);
    await withRedis(() => this.redis.set(key, '1', 'EX', SESSION_REVOCATION_TTL_SECONDS));
  }

  async revokeMany(sessionIds: readonly string[]): Promise<void> {
    const keys = [...new Set(sessionIds.map(revokedSessionKey))];
    if (keys.length === 0) return;
    await withRedis(async () => {
      const pipeline = this.redis.multi();
      for (const key of keys) pipeline.set(key, '1', 'EX', SESSION_REVOCATION_TTL_SECONDS);
      const results = await pipeline.exec();
      if (results === null) throw new Error('Redis MULTI was aborted');
      const failed = results.find(([error]) => error !== null);
      if (failed !== undefined) throw failed[0];
    });
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    const key = revokedSessionKey(sessionId);
    return (await withRedis(() => this.redis.exists(key))) === 1;
  }

  /** MGET in batches of `REVOKED_AMONG_BATCH_SIZE`; malformed ids are never revoked. */
  override async revokedAmong(sessionIds: readonly string[]): Promise<ReadonlySet<string>> {
    const ids = [...new Set(sessionIds.filter((id) => UUID.test(id)))];
    const revoked = new Set<string>();
    for (let start = 0; start < ids.length; start += REVOKED_AMONG_BATCH_SIZE) {
      const batch = ids.slice(start, start + REVOKED_AMONG_BATCH_SIZE);
      const values = await withRedis(() => this.redis.mget(batch.map(revokedSessionKey)));
      batch.forEach((id, index) => {
        if (values[index] !== null && values[index] !== undefined) revoked.add(id);
      });
    }
    return revoked;
  }
}
