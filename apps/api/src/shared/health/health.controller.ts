import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { DbHealthIndicator } from '@udemy/nest-common';
import { NoClientAuth, Public } from '../auth';
import { RedisHealthIndicator } from '../redis';

/**
 * Kubernetes probes. VERSION_NEUTRAL keeps them at /api/health/* (no /v1), because
 * probe URLs must not change when the public API gets a new version.
 */
@ApiTags('health')
@Public()
@NoClientAuth() // called by kubelet, not through a BFF
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DbHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /** Liveness: the process is up and the event loop answers. No dependencies on purpose. */
  @Get('live')
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  /**
   * Readiness: dependencies are reachable, so the pod may receive traffic. 503 otherwise.
   * Redis is included because authenticated requests fail closed without it (design D11).
   */
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.db.check('database'), () => this.redis.check('redis')]);
  }
}
