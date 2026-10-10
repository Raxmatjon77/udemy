import { FIXTURE_IDS, type CommerceMockStore } from '@udemy/contracts/testing';

/*
 * Scenario builders on top of the `@udemy/contracts/testing` mock store. The store answers
 * every request as the viewer; the admin console's viewer is the admin, so student actions
 * (checkout, refund requests) briefly switch the viewer and switch back.
 */

export const ADMIN = FIXTURE_IDS.admin;
export const STUDENT = FIXTURE_IDS.student;

function asStudent<T>(store: CommerceMockStore, run: () => T): T {
  const previous = store.viewerId;
  store.viewerId = STUDENT;
  try {
    return run();
  } finally {
    store.viewerId = previous;
  }
}

/** A PAYMENT_REVIEW order of the student (the provider reported a mismatching amount). */
export function seedPaymentReviewOrder(store: CommerceMockStore, courseIds: readonly string[]) {
  const orderId = asStudent(store, () => {
    for (const courseId of courseIds) store.addToCart(courseId);
    const quote = store.quote();
    return store.checkout(crypto.randomUUID(), quote.totals.totalAmount).orderId;
  });
  return store.flagPaymentMismatch(orderId);
}

/**
 * Three auto-approved refunds, then a fourth request that D11 holds for review (the student
 * reached 3 refunds in 90 days). Returns the REQUESTED refund's id and its order id.
 */
export function seedRefundUnderReview(store: CommerceMockStore) {
  return asStudent(store, () => {
    const courses = [FIXTURE_IDS.course, FIXTURE_IDS.course2, FIXTURE_IDS.course];
    for (const courseId of courses) {
      const order = store.seedPaidOrder(STUDENT, [courseId]);
      const line = order.lines[0]!;
      store.requestRefund(order.id, { orderLineId: line.id, reasonCode: 'QUALITY' });
    }
    const order = store.seedPaidOrder(STUDENT, [FIXTURE_IDS.course2]);
    const refund = store.requestRefund(order.id, {
      orderLineId: order.lines[0]!.id,
      reasonCode: 'NOT_AS_EXPECTED',
      comment: 'The course skips the basics.',
    });
    return { refundId: refund.id, orderId: order.id, status: refund.status };
  });
}

/** An admin refund the provider then failed (FAILED, attempt 1). */
export function seedFailedRefund(store: CommerceMockStore) {
  const order = store.seedPaidOrder(STUDENT, [FIXTURE_IDS.course]);
  const [refund] = store.adminRefundLines(
    order.id,
    [order.lines[0]!.id],
    'Customer asked support for a refund.',
  );
  store.settleRefund(refund!.id, 'FAILED');
  return { refundId: refund!.id, orderId: order.id };
}
