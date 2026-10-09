import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { MessagingModule } from '../messaging';
import { HealthController } from './health.controller';
import { KafkaHealthIndicator } from './kafka-health.indicator';

@Module({
  imports: [TerminusModule.forRoot({ logger: false }), MessagingModule],
  controllers: [HealthController],
  providers: [KafkaHealthIndicator],
})
export class HealthModule {}
