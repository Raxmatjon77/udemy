import { Injectable, Logger, type OnApplicationBootstrap, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { GATEWAY_METADATA, MESSAGE_MAPPING_METADATA } from '@nestjs/websockets/constants';
import { isPermission, REALTIME_SOCKET_PATH } from '@udemy/contracts';
import { AuthMetadataReader, type RouteAuthDescriptor } from '../../../shared/auth';
import { isRealtimeGateway } from '../../../shared/realtime';
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

/** A class with `@WebSocketGateway` metadata and/or `@SubscribeMessage` handlers. */
interface DiscoveredSocketClass {
  readonly type: { readonly name: string; readonly prototype: unknown };
  readonly isGateway: boolean;
  readonly isRealtime: boolean;
  /** `@SubscribeMessage` handlers as `{ name: 'Class.method', handler }`. */
  readonly handlers: readonly { readonly name: string; readonly handler: object }[];
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
 *
 * Socket.io (Phase 5 design §9): every `@SubscribeMessage` handler is audited like a route. Boot
 * fails for a gateway that is not a `@RealtimeGateway`, a `@SubscribeMessage` outside one, a
 * gateway handler without a security marker, with `@NoClientAuth` / `@WebhookIngress` (sockets are
 * always bound to a BFF app and a user), or with `@CheckPolicy` (it reads HTTP route params). The
 * realtime ingress (`/realtime/socket.io`) is logged next to the non-BFF routes.
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
    const gateways = this.realtimeGateways();
    if (gateways.length > 0) {
      this.logger.log(
        `Realtime ingress: WS ${REALTIME_SOCKET_PATH}/ [ticket handshake] (gateways: ${gateways.join(', ')})`,
      );
    }
  }

  /** All misconfigured routes (empty = OK). */
  audit(): RouteSecurityFinding[] {
    const findings: RouteSecurityFinding[] = [];
    const routes = this.routes();
    for (const { name, controller, handler } of routes) {
      const problems = this.problemsOf(this.reader.describe(handler, controller));
      if (problems.length > 0) findings.push({ route: name, problems });
    }
    let socketHandlers = 0;
    for (const socketClass of this.socketClasses()) {
      socketHandlers += socketClass.handlers.length;
      findings.push(...this.socketFindings(socketClass));
    }
    if (findings.length === 0) {
      this.logger.log(
        `Route security audit passed (${routes.length} routes, ${socketHandlers} socket handlers)`,
      );
    }
    return findings;
  }

  /** Names of the `@RealtimeGateway` classes (the socket.io ingress), sorted. */
  realtimeGateways(): string[] {
    return this.socketClasses()
      .filter((c) => c.isGateway && c.isRealtime)
      .map((c) => c.type.name)
      .sort();
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

  /** Every provider or controller class that is a gateway or has `@SubscribeMessage` handlers. */
  private socketClasses(): DiscoveredSocketClass[] {
    const seen = new Set<unknown>();
    const classes: DiscoveredSocketClass[] = [];
    for (const wrapper of [...this.discovery.getProviders(), ...this.discovery.getControllers()]) {
      const type: unknown = wrapper.metatype;
      if (typeof type !== 'function' || seen.has(type)) continue;
      seen.add(type);
      const prototype: unknown = type.prototype;
      if (typeof prototype !== 'object' || prototype === null) continue;
      const handlers: { name: string; handler: object }[] = [];
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler: unknown = Reflect.get(prototype, methodName);
        if (typeof handler !== 'function') continue;
        if (Reflect.getMetadata(MESSAGE_MAPPING_METADATA, handler) !== true) continue;
        handlers.push({ name: `${type.name}.${methodName}`, handler });
      }
      const isGateway = Reflect.getMetadata(GATEWAY_METADATA, type) === true;
      if (!isGateway && handlers.length === 0) continue;
      classes.push({ type, isGateway, isRealtime: isRealtimeGateway(type), handlers });
    }
    return classes;
  }

  private socketFindings(socketClass: DiscoveredSocketClass): RouteSecurityFinding[] {
    const { type, isGateway, isRealtime, handlers } = socketClass;
    if (isGateway && !isRealtime) {
      return [
        {
          route: type.name,
          problems: [
            '@WebSocketGateway without @RealtimeGateway: gateways must use @RealtimeGateway() (ticket handshake, path, WebSocket transport)',
          ],
        },
      ];
    }
    if (!isGateway) {
      return handlers.map(({ name }) => ({
        route: name,
        problems: ['@SubscribeMessage outside a @RealtimeGateway class'],
      }));
    }
    const findings: RouteSecurityFinding[] = [];
    for (const { name, handler } of handlers) {
      const descriptor = this.reader.describe(handler, type);
      const problems = [...descriptor.problems];
      if (descriptor.client.kind === 'none' && !problems.some((p) => p.includes('@NoClientAuth'))) {
        problems.push('@NoClientAuth on a socket handler: sockets are always bound to a BFF app');
      }
      if (descriptor.ingress.kind === 'webhook') {
        problems.push('@WebhookIngress on a socket handler');
      }
      if (descriptor.security.kind === 'authorized' && descriptor.security.policies.length > 0) {
        problems.push(
          '@CheckPolicy on a socket handler: it reads HTTP route params; check the resource in the handler',
        );
      }
      if (problems.length > 0) findings.push({ route: name, problems });
    }
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
