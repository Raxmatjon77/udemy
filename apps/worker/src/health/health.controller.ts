import { Controller, Get } from '@nestjs/common';
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { DbHealthIndicator } from '@udemy/nest-common';
import { KafkaHealthIndicator } from './kafka-health.indicator';

/** The worker's only HTTP surface: probes for Kubernetes on WORKER_HEALTH_PORT. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DbHealthIndicator,
    private readonly kafka: KafkaHealthIndicator,
  ) {}

  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.db.check('database'), () => this.kafka.check('kafka')]);
  }
}
