import { Global, Module } from '@nestjs/common';
import { OutboxPublisher } from './outbox.publisher';

@Global()
@Module({
  providers: [OutboxPublisher],
  exports: [OutboxPublisher],
})
export class OutboxModule {}
