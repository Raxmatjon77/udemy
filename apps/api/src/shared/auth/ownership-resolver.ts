import { Injectable } from '@nestjs/common';
import { AUTH_METADATA, authMetadataDecorator, getAuthMetadata } from './auth-metadata';
import type { PolicyResource } from './policy';

/**
 * Answers "who owns resource X?" for `@CheckPolicy` with `:own` permissions. Each module
 * registers one per resource type it owns, e.g. users: `instructor_application`.
 */
export interface OwnershipResolver {
  /** The owner's userId, or `null` when the resource does not exist (-> 404). */
  ownerOf(resourceId: string): Promise<string | null>;
}

type OwnershipResolverClass = abstract new (...args: never[]) => OwnershipResolver;

/**
 * Marks a provider as the OwnershipResolver of `resource`. The access module discovers these
 * via DiscoveryService (T6). Also applies `@Injectable()`.
 *
 *   @OwnershipResolverFor('instructor_application')
 *   export class InstructorApplicationOwnership implements OwnershipResolver { ... }
 */
export function OwnershipResolverFor(
  resource: PolicyResource,
): <T extends OwnershipResolverClass>(target: T) => void {
  return (target) => {
    Injectable()(target);
    authMetadataDecorator(AUTH_METADATA.ownershipResource, () => resource)(target);
  };
}

/** The resource type a provider class resolves ownership for, if it is an OwnershipResolver. */
export function getOwnershipResource(target: object): PolicyResource | undefined {
  return getAuthMetadata(AUTH_METADATA.ownershipResource, target);
}
