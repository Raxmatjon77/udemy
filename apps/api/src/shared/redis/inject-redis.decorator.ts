import { Inject } from '@nestjs/common';
import { REDIS } from './redis.constants';

/** Shorthand for `@Inject(REDIS)`. */
export const InjectRedis = (): PropertyDecorator & ParameterDecorator => Inject(REDIS);
