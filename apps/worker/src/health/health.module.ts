import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { MessagingModule } from '../messaging';
import { HealthController } from './health.controller';
import { KafkaHealthIndicator } from './kafka-health.indicator';
import { S3HealthIndicator } from './s3-health.indicator';

@Module({
  imports: [TerminusModule.forRoot({ logger: false }), MessagingModule],
  controllers: [HealthController],
  providers: [KafkaHealthIndicator, S3HealthIndicator],
})
export class HealthModule {}
