import 'reflect-metadata';
import type { ClientApp, Permission } from '@udemy/contracts';
import type { PolicyResource, PolicySpec } from './policy';
import type { WebhookProvider } from './webhook-provider';

/**
 * Reflect-metadata keys written by the shared/auth decorators. Read them only through
 * `getAuthMetadata` / `AuthMetadataReader`, so guards and the boot-time route auditor
 * interpret them identically.
 */
export const AUTH_METADATA = {
  public: 'udemy:auth:public',
  authenticatedOnly: 'udemy:auth:authenticated-only',
  permissions: 'udemy:auth:permissions',
  policies: 'udemy:auth:policies',
  noClientAuth: 'udemy:auth:no-client-auth',
  allowClients: 'udemy:auth:allow-clients',
  ownershipResource: 'udemy:auth:ownership-resource',
  /** On a route: public provider ingress (`@WebhookIngress`). */
  webhookIngress: 'udemy:auth:webhook-ingress',
  /** On a guard class: it verifies this provider's signature (`@VerifiesWebhookSignature`). */
  webhookSignatureVerifier: 'udemy:auth:webhook-signature-verifier',
} as const;

/** The value type stored under each key. */
export interface AuthMetadataValues {
  [AUTH_METADATA.public]: true;
  [AUTH_METADATA.authenticatedOnly]: true;
  [AUTH_METADATA.permissions]: readonly Permission[];
  [AUTH_METADATA.policies]: readonly PolicySpec[];
  [AUTH_METADATA.noClientAuth]: true;
  [AUTH_METADATA.allowClients]: readonly ClientApp[];
  [AUTH_METADATA.ownershipResource]: PolicyResource;
  [AUTH_METADATA.webhookIngress]: WebhookProvider;
  [AUTH_METADATA.webhookSignatureVerifier]: WebhookProvider;
}

export type AuthMetadataKey = keyof AuthMetadataValues;

/**
 * Typed read of one key from a handler function or a controller/provider class. Class
 * metadata is inherited by subclasses (prototype chain); handler metadata is per function.
 */
export function getAuthMetadata<TKey extends AuthMetadataKey>(
  key: TKey,
  target: object,
): AuthMetadataValues[TKey] | undefined {
  return Reflect.getMetadata(key, target) as AuthMetadataValues[TKey] | undefined;
}

/**
 * Writes a key on the decorated method (handler) or class. `merge` receives the value already
 * set on that same target, so repeated decorators combine instead of silently overwriting.
 */
export function authMetadataDecorator<TKey extends AuthMetadataKey>(
  key: TKey,
  merge: (existing: AuthMetadataValues[TKey] | undefined) => AuthMetadataValues[TKey],
): ClassDecorator & MethodDecorator {
  return (target: object, _propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    const holder: object =
      descriptor !== undefined && typeof descriptor.value === 'function'
        ? (descriptor.value as object)
        : target;
    const existing = Reflect.getOwnMetadata(key, holder) as AuthMetadataValues[TKey] | undefined;
    Reflect.defineMetadata(key, merge(existing), holder);
  };
}
