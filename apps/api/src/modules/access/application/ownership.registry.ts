import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import {
  getOwnershipResource,
  type OwnershipResolver,
  type PolicyResource,
} from '../../../shared/auth';

function isOwnershipResolver(value: unknown): value is OwnershipResolver {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<OwnershipResolver>).ownerOf === 'function'
  );
}

function nameOf(wrapper: InstanceWrapper): string {
  return typeof wrapper.metatype === 'function' ? wrapper.metatype.name : String(wrapper.token);
}

/**
 * Finds every provider marked with `@OwnershipResolverFor(resource)` in the whole app
 * (DiscoveryService), so other modules plug in ownership checks without importing access.
 * Fails startup on duplicates, non-singleton scopes and classes without `ownerOf`.
 */
@Injectable()
export class OwnershipRegistry implements OnModuleInit {
  private resolvers: ReadonlyMap<PolicyResource, OwnershipResolver> | undefined;

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    this.scan();
  }

  /** The resolver for `resource`, or undefined when no module registered one. */
  get(resource: PolicyResource): OwnershipResolver | undefined {
    return this.scan().get(resource);
  }

  has(resource: PolicyResource): boolean {
    return this.scan().has(resource);
  }

  private scan(): ReadonlyMap<PolicyResource, OwnershipResolver> {
    if (this.resolvers !== undefined) return this.resolvers;

    const found = new Map<PolicyResource, { name: string; instance: OwnershipResolver }>();
    const problems: string[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const metatype = wrapper.metatype;
      if (typeof metatype !== 'function') continue;
      const resource = getOwnershipResource(metatype);
      if (resource === undefined) continue;

      const name = nameOf(wrapper);
      if (!wrapper.isDependencyTreeStatic()) {
        problems.push(`${name} (${resource}) must be a singleton provider`);
        continue;
      }
      const instance: unknown = wrapper.instance;
      if (!isOwnershipResolver(instance)) {
        problems.push(`${name} (${resource}) does not implement ownerOf(resourceId)`);
        continue;
      }
      const existing = found.get(resource);
      if (existing !== undefined && existing.instance !== instance) {
        problems.push(
          `duplicate OwnershipResolver for '${resource}': ${existing.name} and ${name}`,
        );
        continue;
      }
      found.set(resource, { name, instance });
    }
    if (problems.length > 0) {
      throw new Error(`Invalid @OwnershipResolverFor providers:\n  - ${problems.join('\n  - ')}`);
    }
    this.resolvers = new Map([...found].map(([resource, entry]) => [resource, entry.instance]));
    return this.resolvers;
  }
}
