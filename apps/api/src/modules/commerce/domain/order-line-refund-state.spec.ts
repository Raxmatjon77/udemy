import { ErrorCode } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { type LineRefundInput, lineRefundState } from './order-line-refund-state';

const paidAt = new Date('2026-10-01T10:00:00.000Z');
const input = (overrides: Partial<LineRefundInput>): LineRefundInput => ({
  orderStatus: 'PAID',
  paidAt,
  finalMinor: 1999,
  latestRefund: null,
  now: new Date('2026-10-10T10:00:00.000Z'),
  refundWindowDays: 30,
  ...overrides,
});

describe('lineRefundState (D11, the RequestRefund rules)', () => {
  it('a paid line inside the window is eligible until paid_at + 30 days', () => {
    expect(lineRefundState(input({}))).toEqual({
      refundId: null,
      status: null,
      refundableUntil: new Date('2026-10-31T10:00:00.000Z'),
      eligible: true,
      reason: null,
    });
    expect(lineRefundState(input({ orderStatus: 'PARTIALLY_REFUNDED' })).eligible).toBe(true);
  });

  it('past the window: refund_window_closed (the boundary instant is still open)', () => {
    expect(lineRefundState(input({ now: new Date('2026-10-31T10:00:00.000Z') })).eligible).toBe(
      true,
    );
    expect(lineRefundState(input({ now: new Date('2026-10-31T10:00:00.001Z') })).reason).toBe(
      ErrorCode.RefundWindowClosed,
    );
  });

  it('unpaid, 0.00 lines and other statuses are refund_not_applicable', () => {
    expect(lineRefundState(input({ orderStatus: 'PENDING_PAYMENT', paidAt: null }))).toMatchObject({
      refundableUntil: null,
      reason: ErrorCode.RefundNotApplicable,
    });
    expect(lineRefundState(input({ finalMinor: 0 }))).toMatchObject({
      refundableUntil: null,
      reason: ErrorCode.RefundNotApplicable,
    });
    expect(lineRefundState(input({ orderStatus: 'PAYMENT_REVIEW', paidAt: null })).reason).toBe(
      ErrorCode.RefundNotApplicable,
    );
    expect(lineRefundState(input({ orderStatus: 'REFUNDED' })).reason).toBe(
      ErrorCode.RefundNotApplicable,
    );
  });

  it('a live refund blocks with refund_already_requested; REJECTED / FAILED do not', () => {
    for (const status of ['REQUESTED', 'APPROVED', 'SUBMITTED', 'SUCCEEDED'] as const) {
      expect(lineRefundState(input({ latestRefund: { id: 'r', status } }))).toMatchObject({
        refundId: 'r',
        status,
        eligible: false,
        reason: ErrorCode.RefundAlreadyRequested,
      });
    }
    for (const status of ['REJECTED', 'FAILED'] as const) {
      expect(lineRefundState(input({ latestRefund: { id: 'r', status } }))).toMatchObject({
        refundId: 'r',
        status,
        eligible: true,
      });
    }
  });
});
