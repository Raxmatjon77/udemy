import { Module } from '@nestjs/common';
import { DebugEventHandler } from './debug-event.handler';

/** Every @EventHandler provider listed here is discovered and subscribed automatically. */
@Module({
  providers: [DebugEventHandler],
})
export class HandlersModule {}
