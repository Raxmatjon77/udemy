import type { Request } from 'express';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AUTH_METADATA, getAuthMetadata } from './auth-metadata';
import {
  AllowClients,
  AuthenticatedOnly,
  CheckPolicy,
  NoClientAuth,
  Public,
  RequirePermissions,
} from './auth.decorators';
import {
  getOwnershipResource,
  type OwnershipResolver,
  OwnershipResolverFor,
} from './ownership-resolver';
import type { PolicyAction, PolicyResource } from './policy';

const byId = (req: Request): string => String(req.params.id);

class Fixture {
  @Public()
  open(): void {}

  @AuthenticatedOnly()
  me(): void {}

  @RequirePermissions('user:read:any')
  @RequirePermissions('user:ban:any', 'user:read:any')
  ban(): void {}

  @CheckPolicy({ resource: 'instructor_application', action: 'read', id: byId })
  @CheckPolicy({ resource: 'instructor_application', action: 'withdraw', id: byId })
  application(): void {}

  @NoClientAuth()
  jwks(): void {}

  @AllowClients('admin')
  @AllowClients('instructor', 'admin')
  adminOnly(): void {}
}

@AllowClients('student')
@RequirePermissions('profile:read:own')
class DecoratedController {}

describe('shared/auth decorators', () => {
  it('@Public and @AuthenticatedOnly set a flag on the handler only', () => {
    expect(getAuthMetadata(AUTH_METADATA.public, Fixture.prototype.open)).toBe(true);
    expect(getAuthMetadata(AUTH_METADATA.authenticatedOnly, Fixture.prototype.me)).toBe(true);
    expect(getAuthMetadata(AUTH_METADATA.public, Fixture.prototype.me)).toBeUndefined();
    expect(getAuthMetadata(AUTH_METADATA.public, Fixture)).toBeUndefined();
  });

  it('@RequirePermissions merges repeated use into one de-duplicated set', () => {
    expect(getAuthMetadata(AUTH_METADATA.permissions, Fixture.prototype.ban)).toEqual([
      'user:ban:any',
      'user:read:any',
    ]);
  });

  it('@RequirePermissions rejects values outside the catalog at decoration time', () => {
    const bogus = 'course:delete:any' as Parameters<typeof RequirePermissions>[0];
    expect(() => RequirePermissions(bogus)).toThrow(TypeError);
  });

  it('@CheckPolicy stores every policy with its id extractor', () => {
    const policies = getAuthMetadata(AUTH_METADATA.policies, Fixture.prototype.application);

    expect(policies?.map((p) => `${p.resource}:${p.action}`).sort()).toEqual([
      'instructor_application:read',
      'instructor_application:withdraw',
    ]);
    expect(policies?.[0]?.id({ params: { id: 'app-1' } } as unknown as Request)).toBe('app-1');
  });

  it('@CheckPolicy only accepts resource/action pairs that have scoped permissions', () => {
    expectTypeOf<PolicyResource>().toEqualTypeOf<
      'profile' | 'session' | 'instructor_application' | 'user' | 'role' | 'course' | 'media_asset'
    >();
    expectTypeOf<PolicyAction<'course'>>().toEqualTypeOf<
      'read' | 'update' | 'delete' | 'submit' | 'archive' | 'moderate'
    >();
    expectTypeOf<PolicyAction<'media_asset'>>().toEqualTypeOf<'read' | 'upload'>();
    expectTypeOf<PolicyAction<'instructor_application'>>().toEqualTypeOf<
      'create' | 'read' | 'withdraw' | 'review'
    >();
    const forged = { resource: 'user', action: 'delete', id: byId } as unknown as Parameters<
      typeof CheckPolicy
    >[0];
    expect(() => CheckPolicy(forged)).toThrow(TypeError);
  });

  it('@NoClientAuth and @AllowClients store client restrictions', () => {
    expect(getAuthMetadata(AUTH_METADATA.noClientAuth, Fixture.prototype.jwks)).toBe(true);
    expect(getAuthMetadata(AUTH_METADATA.allowClients, Fixture.prototype.adminOnly)).toEqual([
      'instructor',
      'admin',
    ]);
    const bogus = 'mobile' as Parameters<typeof AllowClients>[0];
    expect(() => AllowClients(bogus)).toThrow(TypeError);
  });

  it('works on controller classes, and subclasses inherit it', () => {
    class Child extends DecoratedController {}

    expect(getAuthMetadata(AUTH_METADATA.allowClients, DecoratedController)).toEqual(['student']);
    expect(getAuthMetadata(AUTH_METADATA.permissions, Child)).toEqual(['profile:read:own']);
  });

  it('@OwnershipResolverFor tags the resolver class with its resource type', () => {
    @OwnershipResolverFor('instructor_application')
    class ApplicationOwnership implements OwnershipResolver {
      async ownerOf(id: string): Promise<string | null> {
        return id === 'known' ? 'user-1' : null;
      }
    }

    expect(getOwnershipResource(ApplicationOwnership)).toBe('instructor_application');
    expect(getOwnershipResource(DecoratedController)).toBeUndefined();
  });
});
