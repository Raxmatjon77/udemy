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

  it('contains exactly the Phase 1 entries (no course permissions yet)', () => {
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
      ].sort(),
    );
  });

  it('guards and parses permissions', () => {
    expect(isPermission('user:ban:any')).toBe(true);
    expect(isPermission('course:create')).toBe(false);
    expect(PermissionSchema.safeParse('user:ban:own').success).toBe(false);
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
