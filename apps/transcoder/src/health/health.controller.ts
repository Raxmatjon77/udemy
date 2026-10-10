import { Controller, Get } from '@nestjs/common';
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { DbHealthIndicator } from '@udemy/nest-common';
import { FfmpegHealthIndicator, StorageHealthIndicator } from './health-indicators';

/** The transcoder's only HTTP surface: probes on TRANSCODER_HEALTH_PORT. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DbHealthIndicator,
    private readonly storage: StorageHealthIndicator,
    private readonly ffmpeg: FfmpegHealthIndicator,
  ) {}

  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.db.check('database'),
      () => this.storage.check('storage'),
      () => this.ffmpeg.check('ffmpeg'),
    ]);
  }
}
