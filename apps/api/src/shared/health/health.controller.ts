import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { DbHealthIndicator } from '@udemy/nest-common';

/**
 * Kubernetes probes. VERSION_NEUTRAL keeps them at /api/health/* (no /v1), because
 * probe URLs must not change when the public API gets a new version.
 */
@ApiTags('health')
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DbHealthIndicator,
  ) {}

  /** Liveness: the process is up and the event loop answers. No dependencies on purpose. */
  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  /** Readiness: dependencies are reachable, so the pod may receive traffic. 503 otherwise. */
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.db.check('database')]);
  }
}
