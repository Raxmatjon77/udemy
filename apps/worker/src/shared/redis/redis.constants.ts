import { Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';

/**
 * Injection token of the worker's ioredis client (Phase 5 learning experience design finding 8:
 * the worker gets Redis for the socket.io emitter). `Symbol.for` keeps the token identical if
 * this file is ever loaded twice.
 */
export const REDIS = Symbol.for('udemy.worker.REDIS');

export type RedisClient = Redis;

/** Shorthand for `@Inject(REDIS)`. */
export const InjectRedis = (): PropertyDecorator & ParameterDecorator => Inject(REDIS);
