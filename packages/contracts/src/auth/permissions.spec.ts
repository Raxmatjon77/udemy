import { describe, expect, it } from 'vitest';
import { ClientAppSchema } from './client-app';
import { isPermission, PERMISSION_FORMAT, PERMISSIONS, PermissionSchema } from './permissions';
import { AssignableRoleSchema, RoleSchema } from './role';

describe('permission catalog', () => {
  it('has no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it.each(PERMISSIONS)('%s follows resource:action[:own|:any]', (permission) => {
    expect(permission).toMatch(PERMISSION_FORMAT);
  });

  it('contains exactly the Phase 1, 2 and 4 entries', () => {
    expect([...PERMISSIONS].sort()).toEqual(
      [
        'profile:read:own',
        'profile:update:own',
        'session:manage:own',
        'instructor_application:create:own',
        'instructor_application:read:own',
        'instructor_application:withdraw:own',
        'user:read:any',
        'user:ban:any',
        'instructor_application:read:any',
        'instructor_application:review:any',
        'role:grant:any',
        // Phase 2: INSTRUCTOR
        'course:create',
        'course:read:own',
        'course:update:own',
        'course:delete:own',
        'course:submit:own',
        'course:archive:own',
        'media_asset:create',
        'media_asset:read:own',
        'media_asset:upload:own',
        // Phase 2: ADMIN
        'course:read:any',
        'course:moderate:any',
        'category:manage',
        'media_asset:read:any',
        // Phase 4: STUDENT
        'cart:manage',
        'order:create',
        'order:read:own',
        'order:refund:own',
        'enrollment:create',
        'enrollment:read:own',
        // Phase 4: INSTRUCTOR
        'sales:read:own',
        // Phase 4: ADMIN
        'order:read:any',
        'order:refund:any',
        'refund:review:any',
        'platform_coupon:manage',
        'enrollment:read:any',
        'enrollment:grant:any',
      ].sort(),
    );
  });

  it('guards and parses permissions', () => {
    expect(isPermission('user:ban:any')).toBe(true);
    expect(isPermission('course:create')).toBe(true);
    expect(isPermission('course:delete:any')).toBe(false);
    expect(isPermission('section:update:own')).toBe(false);
    expect(PermissionSchema.safeParse('user:ban:own').success).toBe(false);
    expect(PermissionSchema.safeParse('media_asset:upload:any').success).toBe(false);
  });

  it('knows the Phase 4 commerce and enrollment permissions (design §8)', () => {
    expect(isPermission('order:refund:own')).toBe(true);
    expect(isPermission('platform_coupon:manage')).toBe(true);
    // pricing and coupons go through the course policy; there is no own-scoped coupon permission
    expect(isPermission('coupon:manage:own')).toBe(false);
    expect(isPermission('order:create:any')).toBe(false);
    expect(isPermission('sales:read:any')).toBe(false);
    expect(PermissionSchema.safeParse('enrollment:grant:own').success).toBe(false);
  });
});

describe('roles and client apps', () => {
  it('accepts the known values only', () => {
    expect(RoleSchema.options).toEqual(['STUDENT', 'INSTRUCTOR', 'ADMIN']);
    expect(AssignableRoleSchema.safeParse('STUDENT').success).toBe(false);
    expect(ClientAppSchema.options).toEqual(['student', 'instructor', 'admin']);
    expect(ClientAppSchema.safeParse('STUDENT').success).toBe(false);
  });
});
