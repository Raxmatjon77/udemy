import { type ClientApp, ClientAppSchema, isPermission, type Permission } from '@udemy/contracts';
import { AUTH_METADATA, authMetadataDecorator } from './auth-metadata';
import type { PolicyResource, PolicySpec, PolicySpecFor } from './policy';

/*
 * Route security markers (metadata only; enforced by the global guards in T6/T7).
 *
 * Routes are secure by default: at boot the RouteSecurityAuditor (T6) fails startup when a
 * route has none of @Public, @AuthenticatedOnly, @RequirePermissions or @CheckPolicy.
 * Each marker can be put on a controller class or a handler. If a handler carries any
 * security marker, the handler's markers REPLACE the controller's (no merging across levels).
 * On one level, @Public / @AuthenticatedOnly must stand alone; @RequirePermissions and
 * @CheckPolicy combine (all must pass).
 */

/** No user authentication. Client (BFF) authentication still applies unless @NoClientAuth. */
export const Public = (): ClassDecorator & MethodDecorator =>
  authMetadataDecorator(AUTH_METADATA.public, () => true);

/** Any authenticated principal, no permission needed (e.g. GET /me, logout). */
export const AuthenticatedOnly = (): ClassDecorator & MethodDecorator =>
  authMetadataDecorator(AUTH_METADATA.authenticatedOnly, () => true);

/** The principal must hold ALL listed permissions. Repeated use on one target adds to the set. */
export function RequirePermissions(
  ...permissions: [Permission, ...Permission[]]
): ClassDecorator & MethodDecorator {
  if (permissions.length === 0 || !permissions.every((p) => isPermission(p))) {
    throw new TypeError('@RequirePermissions needs one or more catalog permissions');
  }
  return authMetadataDecorator(AUTH_METADATA.permissions, (existing) => [
    ...new Set([...(existing ?? []), ...permissions]),
  ]);
}

/**
 * Resource-level check: allowed with `<resource>:<action>:any`, or with
 * `<resource>:<action>:own` when the principal owns the resource (ownership comes from the
 * `@OwnershipResolverFor(resource)` provider). Unknown or foreign resources answer 404.
 *
 *   @CheckPolicy({ resource: 'instructor_application', action: 'read', id: (req) => req.params.id })
 */
export function CheckPolicy<R extends PolicyResource>(
  spec: PolicySpecFor<R>,
): ClassDecorator & MethodDecorator {
  const base = `${spec.resource}:${spec.action}`;
  if (!isPermission(`${base}:own`) && !isPermission(`${base}:any`)) {
    throw new TypeError(`@CheckPolicy: no ${base}:own|any permission in the catalog`);
  }
  if (typeof spec.id !== 'function') {
    throw new TypeError('@CheckPolicy: id must be a function of the request');
  }
  const stored = Object.freeze({ ...spec }) as PolicySpec;
  return authMetadataDecorator(AUTH_METADATA.policies, (existing) => [...(existing ?? []), stored]);
}

/**
 * Skip client (BFF) authentication: only for routes that are not called through a BFF
 * (health probes, JWKS, future webhooks). Implies the route cannot be authenticated, because
 * access tokens are bound to a client app; combine it with @Public only.
 */
export const NoClientAuth = (): ClassDecorator & MethodDecorator =>
  authMetadataDecorator(AUTH_METADATA.noClientAuth, () => true);

/** Only these BFFs may call the route (default: any authenticated BFF). */
export function AllowClients(
  ...apps: [ClientApp, ...ClientApp[]]
): ClassDecorator & MethodDecorator {
  if (apps.length === 0 || !apps.every((app) => ClientAppSchema.safeParse(app).success)) {
    throw new TypeError('@AllowClients needs one or more client apps');
  }
  return authMetadataDecorator(AUTH_METADATA.allowClients, (existing) => [
    ...new Set([...(existing ?? []), ...apps]),
  ]);
}
