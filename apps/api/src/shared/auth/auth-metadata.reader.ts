import { type ExecutionContext, Injectable, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import type { ClientApp, Permission } from '@udemy/contracts';
import { AUTH_METADATA, getAuthMetadata } from './auth-metadata';
import type { PolicySpec } from './policy';
import { webhookSignatureProviderOf } from './webhook-ingress.decorators';
import type { WebhookProvider } from './webhook-provider';

/** Where the effective markers were found. */
export type MetadataLevel = 'handler' | 'controller';

export type SecurityMarker = 'Public' | 'AuthenticatedOnly' | 'RequirePermissions' | 'CheckPolicy';

/** Which user-level security applies to a route. */
export type RouteSecurity =
  | { readonly kind: 'public'; readonly level: MetadataLevel }
  | { readonly kind: 'authenticated'; readonly level: MetadataLevel }
  | {
      readonly kind: 'authorized';
      readonly level: MetadataLevel;
      /** All must be held. */
      readonly permissions: readonly Permission[];
      /** All must pass. */
      readonly policies: readonly PolicySpec[];
    }
  /** No marker at all: the auditor fails startup. Guards must deny. */
  | { readonly kind: 'missing' }
  /** Incompatible markers on one level (e.g. @Public + @RequirePermissions). Guards must deny. */
  | {
      readonly kind: 'conflict';
      readonly level: MetadataLevel;
      readonly markers: readonly SecurityMarker[];
    };

/** Which BFF clients may call a route. */
export type ClientAccess =
  /** @NoClientAuth: no client credentials checked. */
  | { readonly kind: 'none'; readonly level: MetadataLevel }
  /** Default: any authenticated client. */
  | { readonly kind: 'any' }
  /** @AllowClients(...): only these apps. */
  | {
      readonly kind: 'restricted';
      readonly level: MetadataLevel;
      readonly apps: readonly ClientApp[];
    }
  /** @NoClientAuth together with @AllowClients on one level. Guards must deny. */
  | { readonly kind: 'conflict'; readonly level: MetadataLevel };

/** How a request reaches the route. */
export type RouteIngress =
  /** Through a BFF (the default), or a public `@NoClientAuth` read (health, JWKS). */
  | { readonly kind: 'default' }
  /** `@WebhookIngress(provider)`: the provider calls the API directly. */
  | {
      readonly kind: 'webhook';
      readonly level: MetadataLevel;
      readonly provider: WebhookProvider;
      /** Names of the `@UseGuards` guards tagged `@VerifiesWebhookSignature(provider)`. */
      readonly signatureGuards: readonly string[];
    };

export interface RouteAuthDescriptor {
  readonly security: RouteSecurity;
  readonly client: ClientAccess;
  readonly ingress: RouteIngress;
  /** Human-readable misconfigurations; non-empty => the route auditor fails startup. */
  readonly problems: readonly string[];
}

interface SecurityMarkers {
  isPublic: boolean;
  authenticatedOnly: boolean;
  permissions: readonly Permission[] | undefined;
  policies: readonly PolicySpec[] | undefined;
}

function readSecurity(target: object): SecurityMarkers {
  return {
    isPublic: getAuthMetadata(AUTH_METADATA.public, target) === true,
    authenticatedOnly: getAuthMetadata(AUTH_METADATA.authenticatedOnly, target) === true,
    permissions: getAuthMetadata(AUTH_METADATA.permissions, target),
    policies: getAuthMetadata(AUTH_METADATA.policies, target),
  };
}

function presentMarkers(m: SecurityMarkers): SecurityMarker[] {
  const present: SecurityMarker[] = [];
  if (m.isPublic) present.push('Public');
  if (m.authenticatedOnly) present.push('AuthenticatedOnly');
  if (m.permissions !== undefined) present.push('RequirePermissions');
  if (m.policies !== undefined) present.push('CheckPolicy');
  return present;
}

function securityAt(m: SecurityMarkers, level: MetadataLevel): RouteSecurity {
  const markers = presentMarkers(m);
  const standalone = markers.filter((x) => x === 'Public' || x === 'AuthenticatedOnly');
  if (standalone.length > 0 && markers.length > 1) {
    return { kind: 'conflict', level, markers };
  }
  if (m.isPublic) return { kind: 'public', level };
  if (m.authenticatedOnly) return { kind: 'authenticated', level };
  return {
    kind: 'authorized',
    level,
    permissions: m.permissions ?? [],
    policies: m.policies ?? [],
  };
}

/** Resolves the user-level security of a route: handler markers replace controller markers. */
export function resolveRouteSecurity(handler: object, controller: object): RouteSecurity {
  const onHandler = readSecurity(handler);
  if (presentMarkers(onHandler).length > 0) return securityAt(onHandler, 'handler');
  const onController = readSecurity(controller);
  if (presentMarkers(onController).length > 0) return securityAt(onController, 'controller');
  return { kind: 'missing' };
}

function clientAt(target: object, level: MetadataLevel): ClientAccess | undefined {
  const none = getAuthMetadata(AUTH_METADATA.noClientAuth, target) === true;
  const apps = getAuthMetadata(AUTH_METADATA.allowClients, target);
  if (none && apps !== undefined) return { kind: 'conflict', level };
  if (none) return { kind: 'none', level };
  if (apps !== undefined) return { kind: 'restricted', level, apps };
  return undefined;
}

/** Resolves which clients may call a route: handler markers replace controller markers. */
export function resolveClientAccess(handler: object, controller: object): ClientAccess {
  return clientAt(handler, 'handler') ?? clientAt(controller, 'controller') ?? { kind: 'any' };
}

function guardsOf(target: object): readonly unknown[] {
  const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, target);
  return Array.isArray(guards) ? guards : [];
}

function guardName(guard: unknown): string {
  if (typeof guard === 'function') return guard.name;
  if (typeof guard === 'object' && guard !== null) return guard.constructor.name;
  return String(guard);
}

/** Resolves the route's ingress: handler `@WebhookIngress` replaces the controller's. */
export function resolveIngress(handler: object, controller: object): RouteIngress {
  const onHandler = getAuthMetadata(AUTH_METADATA.webhookIngress, handler);
  const onController = getAuthMetadata(AUTH_METADATA.webhookIngress, controller);
  const provider = onHandler ?? onController;
  if (provider === undefined) return { kind: 'default' };
  // `@UseGuards` guards run from the controller and the handler alike.
  const signatureGuards = [...guardsOf(controller), ...guardsOf(handler)]
    .filter((guard) => webhookSignatureProviderOf(guard) === provider)
    .map(guardName);
  return {
    kind: 'webhook',
    level: onHandler !== undefined ? 'handler' : 'controller',
    provider,
    signatureGuards,
  };
}

/** The handler's HTTP method; undefined when it is not a route handler. */
function httpMethodOf(handler: object): RequestMethod | undefined {
  const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
  return typeof method === 'number' ? (method as RequestMethod) : undefined;
}

const SAFE_METHODS: ReadonlySet<RequestMethod> = new Set([
  RequestMethod.GET,
  RequestMethod.HEAD,
  RequestMethod.OPTIONS,
]);

function problemsOf(
  security: RouteSecurity,
  client: ClientAccess,
  ingress: RouteIngress,
  method: RequestMethod | undefined,
): string[] {
  const problems: string[] = [];
  if (security.kind === 'missing') {
    problems.push(
      'no security marker (add @Public, @AuthenticatedOnly, @RequirePermissions or @CheckPolicy)',
    );
  }
  if (security.kind === 'conflict') {
    problems.push(`conflicting markers on the ${security.level}: @${security.markers.join(', @')}`);
  }
  if (
    security.kind === 'authorized' &&
    security.permissions.length + security.policies.length === 0
  ) {
    problems.push('empty @RequirePermissions / @CheckPolicy');
  }
  if (client.kind === 'conflict') {
    problems.push(`@NoClientAuth and @AllowClients together on the ${client.level}`);
  }
  if (client.kind === 'none' && security.kind !== 'public' && security.kind !== 'missing') {
    problems.push(
      '@NoClientAuth on a route that needs a user: access tokens are bound to a client app',
    );
  }
  if (ingress.kind === 'webhook') {
    const marker = `@WebhookIngress('${ingress.provider}')`;
    if (security.kind !== 'public' || client.kind !== 'none') {
      problems.push(`${marker} needs @Public and @NoClientAuth: providers send no user or BFF`);
    }
    if (method !== undefined && method !== RequestMethod.POST) {
      problems.push(`${marker} on a ${RequestMethod[method]} route: webhooks must be POST`);
    }
    if (ingress.signatureGuards.length === 0) {
      problems.push(
        `${marker} without a signature guard: add @UseGuards(<guard tagged @VerifiesWebhookSignature('${ingress.provider}')>)`,
      );
    }
  } else if (client.kind === 'none' && method !== undefined && !SAFE_METHODS.has(method)) {
    problems.push(
      `@NoClientAuth on a ${RequestMethod[method]} route: an unauthenticated write must be @WebhookIngress with a signature guard`,
    );
  }
  return problems;
}

/** Full description of a route's auth configuration (guards and the route auditor). */
export function describeRoute(handler: object, controller: object): RouteAuthDescriptor {
  const security = resolveRouteSecurity(handler, controller);
  const client = resolveClientAccess(handler, controller);
  const ingress = resolveIngress(handler, controller);
  const problems = problemsOf(security, client, ingress, httpMethodOf(handler));
  return { security, client, ingress, problems };
}

/**
 * Single source of truth for interpreting the shared/auth metadata. ClientAuthGuard,
 * JwtAuthGuard, PoliciesGuard and the boot-time RouteSecurityAuditor all go through it.
 * Results are cached per (controller, handler): metadata is static after class definition.
 */
@Injectable()
export class AuthMetadataReader {
  private readonly cache = new WeakMap<object, WeakMap<object, RouteAuthDescriptor>>();

  describe(handler: object, controller: object): RouteAuthDescriptor {
    let byHandler = this.cache.get(controller);
    if (byHandler === undefined) {
      byHandler = new WeakMap();
      this.cache.set(controller, byHandler);
    }
    let descriptor = byHandler.get(handler);
    if (descriptor === undefined) {
      descriptor = describeRoute(handler, controller);
      byHandler.set(handler, descriptor);
    }
    return descriptor;
  }

  /** For guards: `this.reader.forContext(ctx)`. */
  forContext(ctx: ExecutionContext): RouteAuthDescriptor {
    return this.describe(ctx.getHandler(), ctx.getClass());
  }
}
