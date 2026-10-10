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
];
const ADMIN_PERMS: Permission[] = [
  'user:read:any',
  'user:ban:any',
  'instructor_application:read:any',
  'instructor_application:review:any',
  'role:grant:any',
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

/** The full matrix (design §4 + D6), written out by hand rather than derived. */
const MATRIX: Record<string, Record<ClientApp, { perms: Permission[]; login: boolean }>> = {
  STUDENT: {
    student: { perms: expected(BASE, STUDENT_PERMS), login: true },
    instructor: { perms: expected(BASE), login: false },
    admin: { perms: expected(BASE), login: false },
  },
  'STUDENT,INSTRUCTOR': {
    student: { perms: expected(BASE, STUDENT_PERMS), login: true },
    instructor: { perms: expected(BASE), login: true },
    admin: { perms: expected(BASE), login: false },
  },
  'STUDENT,ADMIN': {
    student: { perms: expected(BASE, STUDENT_PERMS), login: true },
    instructor: { perms: expected(BASE), login: false },
    admin: { perms: expected(BASE, ADMIN_PERMS), login: true },
  },
  'STUDENT,INSTRUCTOR,ADMIN': {
    student: { perms: expected(BASE, STUDENT_PERMS), login: true },
    instructor: { perms: expected(BASE), login: true },
    admin: { perms: expected(BASE, ADMIN_PERMS), login: true },
  },
};

describe('access permission policy', () => {
  it('BASELINE is exactly the three own-profile/session permissions', () => {
    expect([...BASELINE].sort()).toEqual(expected(BASE));
  });

  it('maps every role to the Phase 1 catalog', () => {
    expect([...ROLE_PERMISSIONS.STUDENT].sort()).toEqual(expected(STUDENT_PERMS));
    expect(ROLE_PERMISSIONS.INSTRUCTOR).toEqual([]);
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
