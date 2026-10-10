/**
 * Commerce emails (Phase 4 design §7, D11), rendered with the shared worker layout: every
 * interpolated value (course titles, coupon codes, the admin's reason, provider ids) is
 * HTML-escaped, titles are kept on one line, and only http(s) links are rendered. Money is
 * shown from its decimal string, never through a float.
 */
import {
  CurrencySchema,
  formatMoney,
  REFUND_REASON_LABELS,
  type RefundReasonCode,
} from '@udemy/contracts';
import { oneLine, type RenderedMail, renderMail, utc } from '../../shared/mail/mail-layout';

/** `$19.99` for the allowlisted currencies, else `19.99 EUR` (the events allow any ISO code). */
export function displayMoney(amount: string, currency: string): string {
  const known = CurrencySchema.safeParse(currency);
  return known.success ? formatMoney(amount, known.data, 'en-US') : `${amount} ${currency}`;
}

/** `"Title"` or a neutral fallback when the commerce row is gone. */
function courseName(title: string | null): string {
  return title === null ? 'your course' : `"${oneLine(title)}"`;
}

/** `order #1042`, or `your order` when the order row is gone (alerts only carry the id). */
function orderName(orderNumber: string | null): string {
  return orderNumber === null ? 'your order' : `order #${orderNumber}`;
}

export interface ReceiptLine {
  readonly courseTitle: string;
  readonly listAmount: string;
  readonly discountAmount: string;
  readonly finalAmount: string;
  readonly couponCode: string | null;
}

/** `commerce.receipt-mailer` (`OrderPaid`): lines, discounts, total and the receipt link. */
export function orderReceiptMail(input: {
  displayName: string;
  orderNumber: number;
  currency: string;
  totalAmount: string;
  paidAt: Date;
  free: boolean;
  lines: readonly ReceiptLine[];
  receiptUrl: string;
}): RenderedMail {
  const money = (amount: string): string => displayMoney(amount, input.currency);
  const lines = input.lines.map((line) => {
    const title = `"${oneLine(line.courseTitle)}"`;
    if (line.discountAmount === '0.00') return `${title}: ${money(line.finalAmount)}`;
    const coupon = line.couponCode === null ? 'discount' : `coupon ${oneLine(line.couponCode)}`;
    return `${title}: ${money(line.listAmount)} − ${money(line.discountAmount)} (${coupon}) = ${money(line.finalAmount)}`;
  });
  return renderMail({
    subject: `Your receipt for order #${input.orderNumber}`,
    greetingName: input.displayName,
    paragraphs: [
      input.free
        ? `Thank you for enrolling. Order #${input.orderNumber} was completed on ${utc(input.paidAt)}; nothing was charged.`
        : `Thank you for your purchase. Order #${input.orderNumber} was paid on ${utc(input.paidAt)}.`,
      ...lines,
      `Total: ${money(input.totalAmount)}`,
      'Your courses are waiting in My learning.',
    ],
    action: { label: 'View your receipt', url: input.receiptUrl },
    footnote: 'Refunds can be requested per course from the order page within the refund window.',
  });
}

/** `commerce.refund-mailer` (`RefundSucceeded`). */
export function refundSucceededMail(input: {
  displayName: string;
  courseTitle: string | null;
  orderNumber: string | null;
  amount: string;
  currency: string;
  succeededAt: Date;
  orderUrl: string;
}): RenderedMail {
  return renderMail({
    subject: 'Your refund was processed',
    greetingName: input.displayName,
    paragraphs: [
      `We refunded ${displayMoney(input.amount, input.currency)} for ${courseName(input.courseTitle)} (${orderName(input.orderNumber)}) on ${utc(input.succeededAt)}.`,
      'Depending on your bank, it can take 5 to 10 business days to appear on your statement.',
      'Your access to the course ended when the refund was approved.',
    ],
    action: { label: 'View your order', url: input.orderUrl },
  });
}

/** `commerce.refund-rejected-mailer` (`RefundRejected`): includes the admin's reason. */
export function refundRejectedMail(input: {
  displayName: string;
  courseTitle: string | null;
  orderNumber: string | null;
  reason: string;
  orderUrl: string;
}): RenderedMail {
  return renderMail({
    subject: 'Your refund request was not approved',
    greetingName: input.displayName,
    paragraphs: [
      `We reviewed your refund request for ${courseName(input.courseTitle)} (${orderName(input.orderNumber)}) and could not approve it.`,
      `Reason: ${input.reason.trim()}`,
      'You keep full access to the course. Contact support if you have questions.',
    ],
    action: { label: 'View your order', url: input.orderUrl },
  });
}

/** `commerce.refund-under-review-mailer` (`RefundRequested`, the NEEDS_REVIEW path of D11). */
export function refundUnderReviewMail(input: {
  displayName: string;
  courseTitle: string | null;
  orderNumber: string | null;
  amount: string;
  currency: string;
  reasonCode: RefundReasonCode;
  orderUrl: string;
}): RenderedMail {
  return renderMail({
    subject: 'We received your refund request',
    greetingName: input.displayName,
    paragraphs: [
      `Your refund request of ${displayMoney(input.amount, input.currency)} for ${courseName(input.courseTitle)} (${orderName(input.orderNumber)}) needs a short review by our team.`,
      `Reason given: ${REFUND_REASON_LABELS[input.reasonCode]}`,
      'We will email you as soon as it is decided. You keep access to the course until then.',
    ],
    action: { label: 'View your order', url: input.orderUrl },
  });
}

/* ----------------------------------------------------------------------------------------
 * commerce.admin-alert-mailer: one mail per active admin
 * -------------------------------------------------------------------------------------- */

/** `OrderPaymentMismatch`: the provider charged something other than the order total. */
export function paymentMismatchAlertMail(input: {
  adminName: string;
  orderNumber: string | null;
  expected: { amount: string; currency: string };
  received: { amount: string; currency: string };
  providerEventId: string;
  detectedAt: Date;
  orderUrl: string;
}): RenderedMail {
  const order = input.orderNumber === null ? 'an order' : `order #${input.orderNumber}`;
  return renderMail({
    subject: `[Alert] Payment mismatch on ${order}`,
    greetingName: input.adminName,
    paragraphs: [
      `The payment provider reported ${displayMoney(input.received.amount, input.received.currency)} for ${order}, but the order total is ${displayMoney(input.expected.amount, input.expected.currency)} (detected ${utc(input.detectedAt)}).`,
      'The order is in payment review: accept the payment or refund it from the order page.',
      `Provider event: ${input.providerEventId}`,
    ],
    action: { label: 'Open the order', url: input.orderUrl },
  });
}

/** `PaymentDisputed`: a chargeback was opened (no automatic revoke in Phase 4). */
export function paymentDisputedAlertMail(input: {
  adminName: string;
  orderNumber: string | null;
  paymentIntentId: string;
  openedAt: Date;
  orderUrl: string;
}): RenderedMail {
  const order = input.orderNumber === null ? 'an order' : `order #${input.orderNumber}`;
  return renderMail({
    subject: `[Alert] Payment disputed on ${order}`,
    greetingName: input.adminName,
    paragraphs: [
      `A dispute (chargeback) was opened for ${order} on ${utc(input.openedAt)}.`,
      'Enrollments are not revoked automatically. Review the order, and respond to the dispute in the payment provider dashboard.',
      `Payment intent: ${input.paymentIntentId}`,
    ],
    action: { label: 'Open the order', url: input.orderUrl },
  });
}

/** `RefundRequested`: a refund needs an admin decision. */
export function refundReviewAlertMail(input: {
  adminName: string;
  courseTitle: string | null;
  orderNumber: string | null;
  amount: string;
  currency: string;
  reasonCode: RefundReasonCode;
  requestedAt: Date;
  queueUrl: string;
}): RenderedMail {
  const order = input.orderNumber === null ? 'an order' : `order #${input.orderNumber}`;
  return renderMail({
    subject: `[Review] Refund request on ${order}`,
    greetingName: input.adminName,
    paragraphs: [
      `A refund request of ${displayMoney(input.amount, input.currency)} for ${courseName(input.courseTitle)} (${order}) needs review (requested ${utc(input.requestedAt)}).`,
      `Reason given: ${REFUND_REASON_LABELS[input.reasonCode]}`,
      'It did not qualify for automatic approval, so it waits in the refund queue.',
    ],
    action: { label: 'Open the refund queue', url: input.queueUrl },
  });
}

/** `RefundFailed`: the provider refund failed; an admin retries or re-grants. */
export function refundFailedAlertMail(input: {
  adminName: string;
  courseTitle: string | null;
  orderNumber: string | null;
  failureCode: string;
  attempt: number;
  failedAt: Date;
  queueUrl: string;
}): RenderedMail {
  const order = input.orderNumber === null ? 'an order' : `order #${input.orderNumber}`;
  return renderMail({
    subject: `[Alert] Refund failed on ${order}`,
    greetingName: input.adminName,
    paragraphs: [
      `The provider refund for ${courseName(input.courseTitle)} (${order}) failed on ${utc(input.failedAt)} (attempt ${input.attempt}).`,
      `Failure code: ${oneLine(input.failureCode)}`,
      'Retry the refund or re-grant the enrollment from the refund queue.',
    ],
    action: { label: 'Open the refund queue', url: input.queueUrl },
  });
}
