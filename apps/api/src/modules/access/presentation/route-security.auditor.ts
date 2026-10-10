import { Injectable, Logger, type OnApplicationBootstrap, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
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

/**
 * A route reachable without client (BFF) credentials (`@NoClientAuth`). Every entry is public
 * ingress, so the set is pinned by a test and printed at boot (commerce design §9).
 */
export interface NonBffRoute {
  /** `Controller.method` */
  readonly route: string;
  /** `GET`, `POST`, ... */
  readonly method: string;
  /** Controller path + handler path, before the global prefix and the version. */
  readonly path: string;
  /** `read` (safe-method public read, e.g. health, JWKS) or `webhook:<provider>`. */
  readonly ingress: string;
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

interface DiscoveredRoute {
  readonly name: string;
  readonly controller: object;
  readonly handler: object;
}

function pathsOf(target: object): string[] {
  const value: unknown = Reflect.getMetadata(PATH_METADATA, target);
  const paths = Array.isArray(value) ? value : [value];
  return paths.map((p) => (typeof p === 'string' ? p.replace(/^\/+|\/+$/g, '') : ''));
}

function joinPath(controllerPath: string, handlerPath: string): string {
  return `/${[controllerPath, handlerPath].filter((p) => p !== '').join('/')}`;
}

/**
 * Routes are secure by default (design §1): at application bootstrap this scans every
 * controller route and fails startup when any route has no security marker, conflicting
 * markers, `@NoClientAuth` on a user route or on an unsafe method without `@WebhookIngress`,
 * a `@WebhookIngress` route that is not a public POST guarded by a signature verifier (all
 * from `AuthMetadataReader.describe`), or a `@CheckPolicy` whose `:own` permission has no
 * registered OwnershipResolver. It then logs every route reachable without a BFF.
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
    const inventory = this.nonBffRoutes();
    this.logger.log(
      `Routes without client credentials (${inventory.length}): ` +
        inventory.map((r) => `${r.method} ${r.path} [${r.ingress}]`).join(', '),
    );
  }

  /** All misconfigured routes (empty = OK). */
  audit(): RouteSecurityFinding[] {
    const findings: RouteSecurityFinding[] = [];
    const routes = this.routes();
    for (const { name, controller, handler } of routes) {
      const problems = this.problemsOf(this.reader.describe(handler, controller));
      if (problems.length > 0) findings.push({ route: name, problems });
    }
    if (findings.length === 0) {
      this.logger.log(`Route security audit passed (${routes.length} routes)`);
    }
    return findings;
  }

  /** Every route that skips client authentication, sorted by method and path. */
  nonBffRoutes(): NonBffRoute[] {
    const inventory: NonBffRoute[] = [];
    for (const { name, controller, handler } of this.routes()) {
      const descriptor = this.reader.describe(handler, controller);
      if (descriptor.client.kind !== 'none') continue;
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      const ingress =
        descriptor.ingress.kind === 'webhook' ? `webhook:${descriptor.ingress.provider}` : 'read';
      for (const controllerPath of pathsOf(controller)) {
        for (const handlerPath of pathsOf(handler)) {
          inventory.push({
            route: name,
            method: RequestMethod[method as RequestMethod] ?? String(method),
            path: joinPath(controllerPath, handlerPath),
            ingress,
          });
        }
      }
    }
    return inventory.sort(
      (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    );
  }

  private routes(): DiscoveredRoute[] {
    const routes: DiscoveredRoute[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        routes.push({ name: `${controller.name}.${methodName}`, controller, handler });
      }
    }
    return routes;
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
