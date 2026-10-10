import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { HealthController } from './health.controller';
import { FfmpegHealthIndicator, StorageHealthIndicator } from './health-indicators';

@Module({
  imports: [TerminusModule.forRoot({ logger: false }), FfmpegModule],
  controllers: [HealthController],
  providers: [StorageHealthIndicator, FfmpegHealthIndicator],
})
export class HealthModule {}
