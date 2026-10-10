import { REFUND_REVIEW_THRESHOLD } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import {
  approvalRevokesAccess,
  decideStudentRefund,
  isLiveRefund,
  refundFailureCode,
} from './refund-policy';

describe('decideStudentRefund (D11, Q3)', () => {
  it('auto-approves below 3 counted refunds in 90 days, reviews from 3 on', () => {
    expect(REFUND_REVIEW_THRESHOLD).toBe(3);
    for (const count of [0, 1, 2]) {
      expect(decideStudentRefund({ recentRefundCount: count, consumptionObjection: null })).toBe(
        'AUTO_APPROVE',
      );
    }
    for (const count of [3, 4, 50]) {
      expect(decideStudentRefund({ recentRefundCount: count, consumptionObjection: null })).toBe(
        'NEEDS_REVIEW',
      );
    }
  });

  it('a consumption objection (Phase 5) sends it to review, never blocks it', () => {
    expect(
      decideStudentRefund({ recentRefundCount: 0, consumptionObjection: 'consumed 80%' }),
    ).toBe('NEEDS_REVIEW');
  });

  it('rejects a count that is not a count', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() =>
        decideStudentRefund({ recentRefundCount: bad, consumptionObjection: null }),
      ).toThrow(RangeError);
    }
  });
});

describe('refund helpers', () => {
  it('live statuses block another refund of the line (refunds_order_line_id_live_uq)', () => {
    expect(
      ['REQUESTED', 'APPROVED', 'SUBMITTED', 'SUCCEEDED'].every((s) => isLiveRefund(s as never)),
    ).toBe(true);
    expect(isLiveRefund('FAILED')).toBe(false);
    expect(isLiveRefund('REJECTED')).toBe(false);
  });

  it('failure codes fit ^[a-z0-9_]{1,64}$', () => {
    expect(refundFailureCode('expired_or_canceled_card', 'x')).toBe('expired_or_canceled_card');
    expect(refundFailureCode('Charge Disputed!', 'x')).toBe('charge_disputed');
    expect(refundFailureCode('', 'provider_failed')).toBe('provider_failed');
    expect(refundFailureCode(null, 'provider_failed')).toBe('provider_failed');
    expect(refundFailureCode('---', 'provider_failed')).toBe('provider_failed');
    expect(refundFailureCode('a'.repeat(100), 'x')).toHaveLength(64);
    expect(() => refundFailureCode('x', 'Bad Fallback')).toThrow(RangeError);
  });

  it('an approval revokes only the access granted by the refunded line', () => {
    const line = 'line-1';
    expect(approvalRevokesAccess({ source: 'ORDER', orderLineId: line }, line)).toBe(true);
    // D15: the active enrollment came from the first purchase.
    expect(approvalRevokesAccess({ source: 'ORDER', orderLineId: 'line-0' }, line)).toBe(false);
    expect(approvalRevokesAccess({ source: 'FREE', orderLineId: null }, line)).toBe(false);
    expect(approvalRevokesAccess({ source: 'ADMIN', orderLineId: null }, line)).toBe(false);
    // PAYMENT_REVIEW: never enrolled.
    expect(approvalRevokesAccess(null, line)).toBe(false);
  });
});
