import { ErrorCode } from '@udemy/contracts';
import { NotFoundError, ValidationError } from '@udemy/nest-common/errors';
import { describe, expect, it } from 'vitest';
import { RoleNotAssignable, UserNotFound } from './access.errors';
import { isAssignableRole } from './role';
import { assertGrantProvenance, assertRoleChangeReason } from './role-change';

describe('access domain rules', () => {
  it('only INSTRUCTOR and ADMIN are assignable', () => {
    expect(isAssignableRole('INSTRUCTOR')).toBe(true);
    expect(isAssignableRole('ADMIN')).toBe(true);
    expect(isAssignableRole('STUDENT')).toBe(false);
    expect(isAssignableRole('admin')).toBe(false);
  });

  it('RoleNotAssignable is a 422 domain error with code role_not_assignable', () => {
    const error = new RoleNotAssignable('STUDENT');
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe(ErrorCode.RoleNotAssignable);
    expect(error.name).toBe('RoleNotAssignable');
  });

  it('UserNotFound is a 404 domain error with code user_not_found', () => {
    const error = new UserNotFound();
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe(ErrorCode.UserNotFound);
  });

  it('validates the reason length', () => {
    expect(() => assertRoleChangeReason('approved')).not.toThrow();
    expect(() => assertRoleChangeReason('   ')).toThrow(ValidationError);
    expect(() => assertRoleChangeReason('x'.repeat(1001))).toThrow(ValidationError);
    expect(() => assertRoleChangeReason('x'.repeat(1000))).not.toThrow();
  });

  it('pairs a null actor with the CLI bootstrap only', () => {
    expect(() => assertGrantProvenance(null, { type: 'cli_bootstrap' })).not.toThrow();
    expect(() => assertGrantProvenance('a', { type: 'admin' })).not.toThrow();
    expect(() => assertGrantProvenance(null, { type: 'admin' })).toThrow(/cli_bootstrap/);
    expect(() => assertGrantProvenance('a', { type: 'cli_bootstrap' })).toThrow(/cli_bootstrap/);
  });
});
