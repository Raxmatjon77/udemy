import { describe, expect, it } from 'vitest';
import { assertAuditFields, isNewGrant, requiresAdminAudit } from './enrollment';
import { InvalidEnrollmentReason } from './enrollment.errors';
import { decideFreeEnrollment, type FreeEnrollmentFacts, isZeroAmount } from './free-enrollment';

const USER = 'u-1';

describe('decideFreeEnrollment (D14, §4 eligibility order)', () => {
  const facts = (overrides: Partial<FreeEnrollmentFacts> = {}): FreeEnrollmentFacts => ({
    userId: USER,
    course: { status: 'PUBLISHED', ownerId: 'owner' },
    priceAmount: '0.00',
    ...overrides,
  });

  it.each<[string, Partial<FreeEnrollmentFacts>, ReturnType<typeof decideFreeEnrollment>]>([
    ['a free published course of someone else', {}, 'ELIGIBLE'],
    ['no live revision', { course: null }, 'COURSE_NOT_FOUND'],
    ['an archived course', { course: { status: 'ARCHIVED', ownerId: 'owner' } }, 'NOT_FOR_SALE'],
    ['no price row (D16)', { priceAmount: null }, 'NOT_FOR_SALE'],
    ['a paid course', { priceAmount: '19.99' }, 'NOT_FREE'],
    ['the own course', { course: { status: 'PUBLISHED', ownerId: USER } }, 'OWN_COURSE'],
    // order: status before price before ownership
    ['own + archived', { course: { status: 'ARCHIVED', ownerId: USER } }, 'NOT_FOR_SALE'],
    [
      'own + paid',
      { course: { status: 'PUBLISHED', ownerId: USER }, priceAmount: '24.99' },
      'NOT_FREE',
    ],
  ])('%s -> %s', (_label, overrides, expected) => {
    expect(decideFreeEnrollment(facts(overrides))).toBe(expected);
  });

  it('isZeroAmount reads decimal strings, never floats', () => {
    expect(['0.00', '0', '0.0', ' 0.00 ', '000.00'].every(isZeroAmount)).toBe(true);
    expect(['0.01', '19.99', '-0.00', '', 'abc', '1e-9'].some(isZeroAmount)).toBe(false);
  });
});

describe('enrollment rules', () => {
  it('only GRANTED and REGRANTED are new grants', () => {
    expect(isNewGrant('GRANTED')).toBe(true);
    expect(isNewGrant('REGRANTED')).toBe(true);
    expect(isNewGrant('ALREADY_ACTIVE')).toBe(false);
  });

  it('ADMIN and CHARGEBACK are audited; ORDER, FREE and REFUND are not', () => {
    expect(['ADMIN', 'CHARGEBACK'].every((k) => requiresAdminAudit(k as 'ADMIN'))).toBe(true);
    expect(['ORDER', 'FREE', 'REFUND'].some((k) => requiresAdminAudit(k as 'ORDER'))).toBe(false);
  });

  it('assertAuditFields needs an actor and a 10-2000 character reason (code points)', () => {
    expect(() => assertAuditFields('FREE', null, null)).not.toThrow();
    expect(() => assertAuditFields('REFUND', null, null)).not.toThrow();
    expect(() => assertAuditFields('ADMIN', 'admin', 'goodwill grant')).not.toThrow();
    expect(() => assertAuditFields('ADMIN', null, 'goodwill grant')).toThrow(
      InvalidEnrollmentReason,
    );
    expect(() => assertAuditFields('ADMIN', 'admin', null)).toThrow(InvalidEnrollmentReason);
    expect(() => assertAuditFields('CHARGEBACK', 'admin', 'too short')).toThrow(
      InvalidEnrollmentReason,
    );
    expect(() => assertAuditFields('ADMIN', 'admin', 'x'.repeat(2001))).toThrow(
      InvalidEnrollmentReason,
    );
    // 10 emoji = 10 characters for Postgres char_length, 20 UTF-16 units for JS
    expect(() => assertAuditFields('ADMIN', 'admin', '😀'.repeat(10))).not.toThrow();
    expect(() => assertAuditFields('ADMIN', 'admin', '😀'.repeat(9))).toThrow(
      InvalidEnrollmentReason,
    );
  });

  it('InvalidEnrollmentReason is a 422 validation_failed on `reason`', () => {
    const error = new InvalidEnrollmentReason();
    expect(error.kind).toBe('validation');
    expect(error.code).toBe('validation_failed');
    expect(error.issues).toEqual([{ path: 'reason', message: error.message }]);
  });
});
