import { SkipThrottle } from '@nestjs/throttler';
import { GLOBAL_THROTTLER } from './throttling.module';

/**
 * Opts a route (or controller) out of the global per-IP throttler. A bare `@SkipThrottle()`
 * only skips a throttler named `default`; ours is named `GLOBAL_THROTTLER`, so it would be a
 * silent no-op.
 */
export const SkipGlobalThrottle = (): ClassDecorator & MethodDecorator =>
  SkipThrottle({ [GLOBAL_THROTTLER]: true });
