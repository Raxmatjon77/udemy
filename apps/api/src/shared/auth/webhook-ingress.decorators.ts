import { applyDecorators, type CanActivate, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { SkipGlobalThrottle } from '../throttler/skip-global-throttle';
import { AUTH_METADATA, authMetadataDecorator, getAuthMetadata } from './auth-metadata';
import { NoClientAuth, Public } from './auth.decorators';
import { isWebhookProvider, type WebhookProvider } from './webhook-provider';

/*
 * Public provider ingress (commerce & enrollment design §9). A webhook is called by the
 * provider itself: no BFF (so no client credentials) and no user (so no Bearer token). The
 * only thing that authenticates it is the provider's signature over the raw request bytes.
 *
 * The RouteSecurityAuditor (through `describeRoute`) therefore accepts a `@WebhookIngress`
 * route only when ALL of these hold, and fails boot otherwise:
 *   1. it is also `@Public()` and `@NoClientAuth()` (so the global guards let it through),
 *   2. it is a POST route,
 *   3. `@UseGuards(...)` on the handler or controller includes a guard class tagged
 *      `@VerifiesWebhookSignature(<same provider>)`.
 * And conversely: `@NoClientAuth()` on an unsafe method (POST/PUT/PATCH/DELETE) without
 * `@WebhookIngress` fails boot, so no unauthenticated write can appear by accident.
 *
 * Use the `WebhookEndpoint(provider, Guard)` composite instead of the single markers.
 */

/**
 * Marks a route (or controller) as public ingress for `provider`. On its own it grants
 * nothing; see the rules above.
 */
export function WebhookIngress(provider: WebhookProvider): ClassDecorator & MethodDecorator {
  if (!isWebhookProvider(provider)) {
    throw new TypeError(`@WebhookIngress: unknown webhook provider '${String(provider)}'`);
  }
  return authMetadataDecorator(AUTH_METADATA.webhookIngress, (existing) => {
    if (existing !== undefined && existing !== provider) {
      throw new TypeError(`@WebhookIngress: '${existing}' and '${provider}' on one target`);
    }
    return provider;
  });
}

/**
 * Tags a guard class as the signature check for `provider`'s webhooks. The guard must verify
 * the provider's signature over `req.rawBody` (a Buffer; `API_APP_OPTIONS.rawBody`) and reject
 * a missing or invalid one; the tag is what lets the route auditor accept the route.
 *
 *   @VerifiesWebhookSignature('stripe')
 *   @Injectable()
 *   export class StripeSignatureGuard implements CanActivate { ... }
 */
export function VerifiesWebhookSignature(
  provider: WebhookProvider,
): <TGuard extends Type<CanActivate>>(target: TGuard) => void {
  if (!isWebhookProvider(provider)) {
    throw new TypeError(
      `@VerifiesWebhookSignature: unknown webhook provider '${String(provider)}'`,
    );
  }
  return (target) => {
    if (typeof (target.prototype as Partial<CanActivate>).canActivate !== 'function') {
      throw new TypeError(`@VerifiesWebhookSignature: ${target.name} is not a guard`);
    }
    authMetadataDecorator(AUTH_METADATA.webhookSignatureVerifier, () => provider)(target);
  };
}

/** The provider whose signature this guard (class or instance) verifies, if any. */
export function webhookSignatureProviderOf(guard: unknown): WebhookProvider | undefined {
  const type: unknown =
    typeof guard === 'function'
      ? guard
      : typeof guard === 'object' && guard !== null
        ? guard.constructor
        : undefined;
  if (typeof type !== 'function') return undefined;
  return getAuthMetadata(AUTH_METADATA.webhookSignatureVerifier, type);
}

/**
 * Everything a provider webhook route needs, in one marker:
 * `@Public() @NoClientAuth() @WebhookIngress(provider) @UseGuards(signatureGuard)`, no global
 * per-IP throttle (every delivery comes from the provider's few IPs; the signature is the gate,
 * design finding 4) and 200 on success (providers retry anything else).
 *
 *   @WebhookEndpoint('stripe', StripeSignatureGuard)
 *   @Post('webhooks/stripe')
 *   receive(@Req() req: RawBodyRequest<Request>) { ... }
 */
export function WebhookEndpoint(
  provider: WebhookProvider,
  signatureGuard: Type<CanActivate>,
): MethodDecorator {
  if (webhookSignatureProviderOf(signatureGuard) !== provider) {
    throw new TypeError(
      `WebhookEndpoint('${provider}'): ${signatureGuard.name} is not tagged @VerifiesWebhookSignature('${provider}')`,
    );
  }
  return applyDecorators(
    Public(),
    NoClientAuth(),
    WebhookIngress(provider),
    UseGuards(signatureGuard),
    SkipGlobalThrottle(),
    HttpCode(HttpStatus.OK),
  );
}
