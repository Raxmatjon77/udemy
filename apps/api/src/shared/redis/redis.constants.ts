import type { Redis } from 'ioredis';

/**
 * Injection token for the process-wide ioredis client (`@InjectRedis() redis: RedisClient`).
 * `Symbol.for` keeps the token identical if this file is ever loaded twice.
 */
export const REDIS = Symbol.for('udemy.REDIS');

export type RedisClient = Redis;
