import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { isPermission } from '@udemy/contracts';
import { AuthMetadataReader, type RouteAuthDescriptor } from '../../../shared/auth';
import { OwnershipRegistry } from '../application/ownership.registry';

/** One misconfigured route handler and everything wrong with it. */
export interface RouteSecurityFinding {
  /** `Controller.method` */
  readonly route: string;
  readonly problems: readonly string[];
}

/** Thrown at startup when at least one route is misconfigured; boot fails. */
export class RouteSecurityError extends Error {
  constructor(readonly findings: readonly RouteSecurityFinding[]) {
    super(
      `Route security audit failed for ${findings.length} route(s):\n` +
        findings.map((f) => `  - ${f.route}: ${f.problems.join('; ')}`).join('\n'),
    );
    this.name = 'RouteSecurityError';
  }
}

/**
 * Routes are secure by default (design §1): at application bootstrap this scans every
 * controller route and fails startup when any route has no security marker, conflicting
 * markers, `@NoClientAuth` on a user route (all from `AuthMetadataReader.describe`), or a
 * `@CheckPolicy` whose `:own` permission has no registered OwnershipResolver.
 */
@Injectable()
export class RouteSecurityAuditor implements OnApplicationBootstrap {
  private readonly logger = new Logger(RouteSecurityAuditor.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reader: AuthMetadataReader,
    private readonly ownership: OwnershipRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const findings = this.audit();
    if (findings.length > 0) throw new RouteSecurityError(findings);
  }

  /** All misconfigured routes (empty = OK). */
  audit(): RouteSecurityFinding[] {
    const findings: RouteSecurityFinding[] = [];
    let routes = 0;
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        routes += 1;
        const problems = this.problemsOf(this.reader.describe(handler, controller));
        if (problems.length > 0) {
          findings.push({ route: `${controller.name}.${methodName}`, problems });
        }
      }
    }
    if (findings.length === 0) this.logger.log(`Route security audit passed (${routes} routes)`);
    return findings;
  }

  private problemsOf(descriptor: RouteAuthDescriptor): string[] {
    const problems = [...descriptor.problems];
    if (descriptor.security.kind === 'authorized') {
      for (const policy of descriptor.security.policies) {
        const own = `${policy.resource}:${policy.action}:own`;
        if (isPermission(own) && !this.ownership.has(policy.resource)) {
          problems.push(
            `@CheckPolicy on '${policy.resource}' needs an @OwnershipResolverFor('${policy.resource}') provider`,
          );
        }
      }
    }
    return problems;
  }
}
