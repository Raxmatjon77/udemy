import { Controller, Get } from '@nestjs/common';
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { DbHealthIndicator } from '@udemy/nest-common';
import { KafkaHealthIndicator } from './kafka-health.indicator';
import { S3HealthIndicator } from './s3-health.indicator';

/** The worker's only HTTP surface: probes for Kubernetes on WORKER_HEALTH_PORT. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DbHealthIndicator,
    private readonly kafka: KafkaHealthIndicator,
    private readonly s3: S3HealthIndicator,
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
      () => this.kafka.check('kafka'),
      () => this.s3.check('s3'),
    ]);
  }
}
