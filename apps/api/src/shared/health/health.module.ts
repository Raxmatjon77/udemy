import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { S3HealthIndicator } from './s3-health.indicator';

@Module({
  // Terminus would log failures with its own logger; ours already logs the details.
  imports: [TerminusModule.forRoot({ logger: false })],
  controllers: [HealthController],
  providers: [S3HealthIndicator],
})
export class HealthModule {}
