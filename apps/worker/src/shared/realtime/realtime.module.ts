import { Global, Module } from '@nestjs/common';
import { RealtimeEmitter } from './realtime-emitter';

/**
 * The worker's realtime push (`@socket.io/redis-emitter`, design D15). Global, so notifiers and
 * the room revoker (P5-T15) inject `RealtimeEmitter` without importing this module. Needs the
 * global RedisModule.
 */
@Global()
@Module({
  providers: [RealtimeEmitter],
  exports: [RealtimeEmitter],
})
export class RealtimeModule {}
