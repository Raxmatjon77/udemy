import { CLIENT_APPS, type ClientApp, type Permission, PERMISSIONS } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import {
  APP_ROLE_SCOPE,
  BASELINE,
  canLoginToApp,
  effectivePermissions,
  ROLE_PERMISSIONS,
} from './permission-policy';
import { ROLES, type Role, withImplicitRole } from './role';

const STUDENT_PERMS: Permission[] = [
  'instructor_application:create:own',
  'instructor_application:read:own',
  'instructor_application:withdraw:own',
  // Phase 4 (commerce & enrollment design §8)
  'cart:manage',
  'order:create',
  'order:read:own',
  'order:refund:own',
  'enrollment:create',
  'enrollment:read:own',
];
const ADMIN_PERMS: Permission[] = [
  'user:read:any',
  'user:ban:any',
  'instructor_application:read:any',
  'instructor_application:review:any',
  'role:grant:any',
  // Phase 2 (catalog & media design §8)
  'course:read:any',
  'course:moderate:any',
  'category:manage',
  'media_asset:read:any',
  // Phase 4 (commerce & enrollment design §8)
  'order:read:any',
  'order:refund:any',
  'refund:review:any',
  'platform_coupon:manage',
  'enrollment:read:any',
  'enrollment:grant:any',
];
/** Phase 2 (catalog & media design §8) and Phase 4 (commerce & enrollment design §8). */
const INSTRUCTOR_PERMS: Permission[] = [
  'course:create',
  'course:read:own',
  'course:update:own',
  'course:delete:own',
  'course:submit:own',
  'course:archive:own',
  'media_asset:create',
  'media_asset:read:own',
  'media_asset:upload:own',
  'sales:read:own',
];
const BASE: Permission[] = ['profile:read:own', 'profile:update:own', 'session:manage:own'];

const sorted = (set: ReadonlySet<Permission>): Permission[] => [...set].sort();
const expected = (...groups: Permission[][]): Permission[] => [...new Set(groups.flat())].sort();

/** Every role combination a user can hold (STUDENT is implicit, so it is in all of them). */
const HOLDINGS: readonly (readonly Role[])[] = [
  ['STUDENT'],
  ['STUDENT', 'INSTRUCTOR'],
  ['STUDENT', 'ADMIN'],
  ['STUDENT', 'INSTRUCTOR', 'ADMIN'],
];

/**
 * The full matrix (design §4 + D6, Phase 2 §8, Phase 4 §8), written out by hand rather than
 * derived.
 */
const MATRIX: Record<string, Record<ClientApp, { perms: Permission[]; login: boolean }>> = {
  STUDENT: {
    student: { perms: expected(BASE, STUDENT_PERMS), login: true },
    instructor: { perms: expected(BASE), login: false },
    admin: { perms: expected(BASE), login: false },
  },
  'STUDENT,INSTRUCTOR': {
    student: { perms: expected(BASE, STUDENT_PERMS), login: true },
    instructor: { perms: expected(BASE, INSTRUCTOR_PERMS), login: true },
    admin: { perms: expected(BASE), login: false },
  },
  'STUDENT,ADMIN': {
    student: { perms: expected(BASE, STUDENT_PERMS), login: true },
    instructor: { perms: expected(BASE), login: false },
    admin: { perms: expected(BASE, ADMIN_PERMS), login: true },
  },
  'STUDENT,INSTRUCTOR,ADMIN': {
    student: { perms: expected(BASE, STUDENT_PERMS), login: true },
    instructor: { perms: expected(BASE, INSTRUCTOR_PERMS), login: true },
    admin: { perms: expected(BASE, ADMIN_PERMS), login: true },
  },
};

describe('access permission policy', () => {
  it('BASELINE is exactly the three own-profile/session permissions', () => {
    expect([...BASELINE].sort()).toEqual(expected(BASE));
  });

  it('maps every role to the Phase 1, 2 and 4 catalog', () => {
    expect([...ROLE_PERMISSIONS.STUDENT].sort()).toEqual(expected(STUDENT_PERMS));
    expect([...ROLE_PERMISSIONS.INSTRUCTOR].sort()).toEqual(expected(INSTRUCTOR_PERMS));
    expect([...ROLE_PERMISSIONS.ADMIN].sort()).toEqual(expected(ADMIN_PERMS));
  });

  it('scopes each app to exactly one role', () => {
    expect(APP_ROLE_SCOPE).toEqual({
      student: ['STUDENT'],
      instructor: ['INSTRUCTOR'],
      admin: ['ADMIN'],
    });
  });

  it('every catalog permission is reachable from BASELINE or a role, and nothing else is used', () => {
    const used = new Set<Permission>([...BASELINE, ...ROLES.flatMap((r) => ROLE_PERMISSIONS[r])]);
    expect([...used].sort()).toEqual([...PERMISSIONS].sort());
  });

  for (const roles of HOLDINGS) {
    for (const app of CLIENT_APPS) {
      const row = MATRIX[roles.join(',')]?.[app];
      it(`${roles.join('+')} in the ${app} app`, () => {
        expect(row).toBeDefined();
        expect(sorted(effectivePermissions(roles, app))).toEqual(row?.perms);
        expect(canLoginToApp(roles, app)).toBe(row?.login);
      });
    }
  }

  it('no role mapping lists a permission twice', () => {
    for (const role of ROLES) {
      expect(new Set(ROLE_PERMISSIONS[role]).size).toBe(ROLE_PERMISSIONS[role].length);
    }
  });

  it('roles do not share permissions (each grant has exactly one owner)', () => {
    const all = ROLES.flatMap((r) => ROLE_PERMISSIONS[r]);
    expect(new Set(all).size).toBe(all.length);
    for (const p of BASELINE) expect(all).not.toContain(p);
  });

  it('STUDENT gets no course/category/media permissions (public reads are @Public)', () => {
    const perms = effectivePermissions(['STUDENT'], 'student');
    for (const p of perms) expect(p).not.toMatch(/^(course|category|media_asset):/);
  });

  it('an INSTRUCTOR only gets course/media permissions in the instructor app', () => {
    const inStudent = effectivePermissions(['STUDENT', 'INSTRUCTOR'], 'student');
    const inAdmin = effectivePermissions(['STUDENT', 'INSTRUCTOR'], 'admin');
    for (const p of INSTRUCTOR_PERMS) {
      expect(inStudent.has(p)).toBe(false);
      expect(inAdmin.has(p)).toBe(false);
    }
  });

  it('INSTRUCTOR course/media permissions are owner-scoped (no :any), creation excepted', () => {
    for (const p of ROLE_PERMISSIONS.INSTRUCTOR) {
      expect(p.endsWith(':any')).toBe(false);
      if (!p.endsWith(':own')) expect(p).toMatch(/:create$/);
    }
  });

  it('ADMIN can read and moderate courses but never author them or upload media', () => {
    const perms = effectivePermissions(['STUDENT', 'ADMIN'], 'admin');
    expect(perms.has('course:read:any')).toBe(true);
    expect(perms.has('course:moderate:any')).toBe(true);
    expect(perms.has('category:manage')).toBe(true);
    expect(perms.has('media_asset:read:any')).toBe(true);
    for (const p of INSTRUCTOR_PERMS) expect(perms.has(p)).toBe(false);
  });

  it('buying (cart, checkout, orders, free enrolment) works only in the student app', () => {
    const buyer: Permission[] = [
      'cart:manage',
      'order:create',
      'order:read:own',
      'order:refund:own',
      'enrollment:create',
      'enrollment:read:own',
    ];
    const everyone: Role[] = ['STUDENT', 'INSTRUCTOR', 'ADMIN'];
    for (const p of buyer) {
      expect(effectivePermissions(everyone, 'student').has(p)).toBe(true);
      expect(effectivePermissions(everyone, 'instructor').has(p)).toBe(false);
      expect(effectivePermissions(everyone, 'admin').has(p)).toBe(false);
    }
  });

  it('money movements and manual grants by staff exist only in the admin app', () => {
    const staff: Permission[] = [
      'order:read:any',
      'order:refund:any',
      'refund:review:any',
      'platform_coupon:manage',
      'enrollment:read:any',
      'enrollment:grant:any',
    ];
    const everyone: Role[] = ['STUDENT', 'INSTRUCTOR', 'ADMIN'];
    for (const p of staff) {
      expect(effectivePermissions(everyone, 'admin').has(p)).toBe(true);
      expect(effectivePermissions(everyone, 'student').has(p)).toBe(false);
      expect(effectivePermissions(everyone, 'instructor').has(p)).toBe(false);
    }
  });

  it('instructor sales are owner-scoped and only in the instructor app', () => {
    const roles: Role[] = ['STUDENT', 'INSTRUCTOR'];
    expect(effectivePermissions(roles, 'instructor').has('sales:read:own')).toBe(true);
    expect(effectivePermissions(roles, 'student').has('sales:read:own')).toBe(false);
    expect(effectivePermissions(['STUDENT', 'ADMIN'], 'admin').has('sales:read:own')).toBe(false);
  });

  it('a user holding INSTRUCTOR+ADMIN never gets both sets in one app', () => {
    const roles: Role[] = ['STUDENT', 'INSTRUCTOR', 'ADMIN'];
    const instructor = effectivePermissions(roles, 'instructor');
    const admin = effectivePermissions(roles, 'admin');
    for (const p of ADMIN_PERMS) expect(instructor.has(p)).toBe(false);
    for (const p of INSTRUCTOR_PERMS) expect(admin.has(p)).toBe(false);
  });

  it('a STUDENT-only user in the admin app gets only BASELINE and cannot log in', () => {
    expect(sorted(effectivePermissions(['STUDENT'], 'admin'))).toEqual(expected(BASE));
    expect(canLoginToApp(['STUDENT'], 'admin')).toBe(false);
  });

  it('an ADMIN does not get admin permissions in the student app', () => {
    const perms = effectivePermissions(['STUDENT', 'ADMIN'], 'student');
    for (const p of ADMIN_PERMS) expect(perms.has(p)).toBe(false);
  });

  it('treats STUDENT as implicit even when the caller omits it', () => {
    expect(sorted(effectivePermissions([], 'student'))).toEqual(expected(BASE, STUDENT_PERMS));
    expect(sorted(effectivePermissions(['ADMIN'], 'student'))).toEqual(
      expected(BASE, STUDENT_PERMS),
    );
    expect(canLoginToApp([], 'student')).toBe(true);
    expect(canLoginToApp(['ADMIN'], 'instructor')).toBe(false);
  });

  it('returns a fresh set per call (callers cannot corrupt shared state)', () => {
    const a = effectivePermissions(['ADMIN'], 'admin') as Set<Permission>;
    a.clear();
    expect(effectivePermissions(['ADMIN'], 'admin').size).toBe(BASE.length + ADMIN_PERMS.length);
  });

  it('withImplicitRole adds STUDENT, dedupes and orders canonically', () => {
    expect(withImplicitRole(['ADMIN', 'INSTRUCTOR', 'ADMIN'])).toEqual([
      'STUDENT',
      'INSTRUCTOR',
      'ADMIN',
    ]);
    expect(withImplicitRole([])).toEqual(['STUDENT']);
  });
});
