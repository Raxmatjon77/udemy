import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRedis } from './inject-redis.decorator';
import type { RedisClient } from './redis.constants';
import { withRedis } from './redis-unavailable.error';

export interface RateLimitRule {
  /** Maximum hits allowed in one window; hit number `limit + 1` is `limited`. */
  limit: number;
  /** Window length. The window starts at the first hit (fixed window, not sliding). */
  windowMs: number;
}

export interface RateLimitResult {
  /** Hits counted in the current window, including this one (for `hit`). */
  count: number;
  /** Time until the window resets; 0 when no window is open. Use it for `Retry-After`. */
  ttlMs: number;
  /** `count > limit`: the caller must refuse the request. */
  limited: boolean;
}

interface LuaScript {
  source: string;
  sha1: string;
}

function script(source: string): LuaScript {
  return { source, sha1: createHash('sha1').update(source).digest('hex') };
}

/**
 * Lua scripts run atomically in Redis, so concurrent hits never lose an increment and a
 * counter can never be left without an expiry (design §6, "Counters are atomic").
 * Both return `{count, ttlMs}`.
 */
export const RATE_LIMIT_SCRIPTS = {
  /** KEYS[1] = counter, ARGV[1] = window in ms. */
  hit: script(
    [
      "local count = redis.call('INCR', KEYS[1])",
      "local ttl = redis.call('PTTL', KEYS[1])",
      // -1 = no expiry: a new counter (or one written without TTL). Start the window now.
      'if ttl < 0 then',
      "  redis.call('PEXPIRE', KEYS[1], ARGV[1])",
      '  ttl = tonumber(ARGV[1])',
      'end',
      'return {count, ttl}',
    ].join('\n'),
  ),
  /** KEYS[1] = counter. Reads without counting. */
  peek: script(
    [
      "local count = tonumber(redis.call('GET', KEYS[1]) or '0')",
      "local ttl = redis.call('PTTL', KEYS[1])",
      'if ttl < 0 then ttl = 0 end',
      'return {count, ttl}',
    ].join('\n'),
  ),
} as const;

const MAX_KEY_LENGTH = 512;

function assertKey(key: string): void {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new TypeError(`Rate-limit key must be 1..${MAX_KEY_LENGTH} characters`);
  }
}

function assertRule(rule: RateLimitRule): void {
  if (!Number.isSafeInteger(rule.limit) || rule.limit < 1) {
    throw new TypeError('RateLimitRule.limit must be a positive integer');
  }
  if (!Number.isSafeInteger(rule.windowMs) || rule.windowMs < 1) {
    throw new TypeError('RateLimitRule.windowMs must be a positive integer');
  }
}

function parseReply(reply: unknown): { count: number; ttlMs: number } {
  if (
    Array.isArray(reply) &&
    reply.length === 2 &&
    typeof reply[0] === 'number' &&
    typeof reply[1] === 'number'
  ) {
    return { count: reply[0], ttlMs: Math.max(0, reply[1]) };
  }
  // A script/parsing bug, not an outage: surfaces as a 500.
  throw new Error('Unexpected rate-limit script reply');
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOSCRIPT');
}

/**
 * Atomic fixed-window counters in Redis, for login/signup/forgot-password limits (design §6
 * "Redis keys", §9 "Rate limits"). Keys are passed in full, e.g. `rl:login:ip:{ip}`; count
 * whether or not the account exists.
 *
 * Fail closed: every Redis failure throws `RedisUnavailableError` (-> 503). A limiter that
 * cannot count must not let the attempt through.
 *
 *   const r = await limiter.hit(`rl:signup:ip:${ip}`, { limit: 10, windowMs: 3_600_000 });
 *   if (r.limited) throw new TooManyAttempts(r.ttlMs);
 */
@Injectable()
export class RateLimiter {
  constructor(@InjectRedis() private readonly redis: RedisClient) {}

  /** Counts one hit and reports whether the limit is now exceeded. */
  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    assertKey(key);
    assertRule(rule);
    const { count, ttlMs } = parseReply(
      await this.run(RATE_LIMIT_SCRIPTS.hit, key, String(rule.windowMs)),
    );
    return { count, ttlMs, limited: count > rule.limit };
  }

  /**
   * Current state without counting, e.g. "already 5 failures for this email+IP?" before
   * verifying a password. `limited` means `count >= limit`: one more hit would exceed it.
   */
  async peek(key: string, rule: Pick<RateLimitRule, 'limit'>): Promise<RateLimitResult> {
    assertKey(key);
    assertRule({ limit: rule.limit, windowMs: 1 });
    const { count, ttlMs } = parseReply(await this.run(RATE_LIMIT_SCRIPTS.peek, key));
    return { count, ttlMs, limited: count >= rule.limit };
  }

  /** Drops the counter (e.g. clear per-email+IP failures after a successful login). */
  async reset(key: string): Promise<void> {
    assertKey(key);
    await withRedis(() => this.redis.del(key));
  }

  /** EVALSHA, falling back to EVAL once when the script cache is empty (Redis restart). */
  private run(lua: LuaScript, key: string, ...args: string[]): Promise<unknown> {
    return withRedis(async () => {
      try {
        return await this.redis.evalsha(lua.sha1, 1, key, ...args);
      } catch (error) {
        if (!isNoScriptError(error)) throw error;
        return this.redis.eval(lua.source, 1, key, ...args);
      }
    });
  }
}
