import { Injectable, Module, Scope } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { type OwnershipResolver, OwnershipResolverFor } from '../../../shared/auth';
import { OwnershipRegistry } from './ownership.registry';

@OwnershipResolverFor('instructor_application')
class ApplicationOwnership implements OwnershipResolver {
  async ownerOf(id: string): Promise<string | null> {
    return id === 'a1' ? 'owner-1' : null;
  }
}

@OwnershipResolverFor('instructor_application')
class DuplicateOwnership implements OwnershipResolver {
  async ownerOf(): Promise<string | null> {
    return null;
  }
}

@Injectable()
class UnrelatedService {}

@Module({ providers: [ApplicationOwnership, UnrelatedService] })
class FeatureModule {}

@Module({ providers: [DuplicateOwnership] })
class OtherFeatureModule {}

async function boot(...imports: (new () => unknown)[]): Promise<OwnershipRegistry> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule, ...imports],
    providers: [OwnershipRegistry],
  }).compile();
  await moduleRef.init();
  return moduleRef.get(OwnershipRegistry);
}

describe('OwnershipRegistry', () => {
  it('discovers @OwnershipResolverFor providers in other modules', async () => {
    const registry = await boot(FeatureModule);
    expect(registry.has('instructor_application')).toBe(true);
    await expect(registry.get('instructor_application')?.ownerOf('a1')).resolves.toBe('owner-1');
  });

  it('is empty when nothing is registered', async () => {
    const registry = await boot();
    expect(registry.get('instructor_application')).toBeUndefined();
  });

  it('fails boot on two resolvers for one resource type', async () => {
    await expect(boot(FeatureModule, OtherFeatureModule)).rejects.toThrow(
      /duplicate OwnershipResolver for 'instructor_application': ApplicationOwnership and DuplicateOwnership/,
    );
  });

  it('fails boot on a request-scoped resolver', async () => {
    @OwnershipResolverFor('instructor_application')
    class ScopedOwnership implements OwnershipResolver {
      async ownerOf(): Promise<string | null> {
        return null;
      }
    }
    Injectable({ scope: Scope.REQUEST })(ScopedOwnership);
    @Module({ providers: [ScopedOwnership] })
    class ScopedModule {}
    await expect(boot(ScopedModule)).rejects.toThrow(/ScopedOwnership .* must be a singleton/);
  });
});
