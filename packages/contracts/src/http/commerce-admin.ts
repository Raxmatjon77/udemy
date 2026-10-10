import { z } from 'zod';
import { CurrencySchema, MoneyAmountSchema } from '../money/money';
import { AccountStatusSchema } from './account-status';
import { PersonRefSchema } from './catalog';
import {
  AdminMoneyReasonSchema,
  CourseTitleSnapshotSchema,
  OrderNumberSchema,
  OrderSettlementProviderSchema,
  OrderStatusSchema,
  OrderTransitionCauseSchema,
  PaymentProviderSchema,
  PaymentStatusSchema,
  ProviderEventOutcomeSchema,
  RefundStatusSchema,
  RevenueShareBpsSchema,
} from './commerce-common';
import { RefundSchema } from './commerce-orders';
import { IsoDateTimeSchema, multilineText, UuidSchema } from './fields';
import { emptyToUndefined, pageSchema, PaginationQuerySchema } from './pagination';

/* ----------------------------------------------------------------------------------------
 * GET /admin/orders?q=&status=&userId=&courseId=&from=&to=&cursor=&limit=
 *   -> 200 AdminOrderPage (P `order:read:any`; 400). Keyset (placedAt DESC, id DESC).
 * `q` is an order number (a leading `#` is not accepted; strip it in the UI).
 * -------------------------------------------------------------------------------------- */

export const AdminOrdersQuerySchema = PaginationQuerySchema.extend({
  q: z.preprocess(emptyToUndefined, z.coerce.number().pipe(OrderNumberSchema).optional()),
  status: z.preprocess(emptyToUndefined, OrderStatusSchema.optional()),
  userId: z.preprocess(emptyToUndefined, UuidSchema.optional()),
  courseId: z.preprocess(emptyToUndefined, UuidSchema.optional()),
  /** `placedAt >= from`. */
  from: z.preprocess(emptyToUndefined, IsoDateTimeSchema.optional()),
  /** `placedAt < to`. */
  to: z.preprocess(emptyToUndefined, IsoDateTimeSchema.optional()),
}).refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), {
  message: 'from must be before to',
  path: ['to'],
});
export type AdminOrdersQuery = z.output<typeof AdminOrdersQuerySchema>;

/** The buyer as admins see them (email included; admin app only). */
export const AdminBuyerSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  email: z.string(),
  status: AccountStatusSchema,
});
export type AdminBuyer = z.infer<typeof AdminBuyerSchema>;

export const AdminOrderRowSchema = z.object({
  id: UuidSchema,
  orderNumber: OrderNumberSchema,
  status: OrderStatusSchema,
  currency: CurrencySchema,
  totalAmount: MoneyAmountSchema,
  lineCount: z.number().int().min(1),
  /** Null when the account no longer exists. */
  buyer: AdminBuyerSchema.nullable(),
  placedAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
});
export type AdminOrderRow = z.infer<typeof AdminOrderRowSchema>;

export const AdminOrderPageSchema = pageSchema(AdminOrderRowSchema);
export type AdminOrderPage = z.infer<typeof AdminOrderPageSchema>;

/* ----------------------------------------------------------------------------------------
 * GET /admin/orders/:orderId -> 200 AdminOrderDetail (P `order:read:any`; 404)
 * Params: `OrderIdParamsSchema`.
 * -------------------------------------------------------------------------------------- */

/** The immutable line snapshot with the revenue split (D6, D13). */
export const AdminOrderLineSchema = z.object({
  id: UuidSchema,
  lineNo: z.number().int().min(1),
  courseId: UuidSchema,
  courseTitle: CourseTitleSnapshotSchema,
  instructorId: UuidSchema,
  /** Resolved live; null when banned or unknown. */
  instructor: PersonRefSchema.nullable(),
  listAmount: MoneyAmountSchema,
  discountAmount: MoneyAmountSchema,
  finalAmount: MoneyAmountSchema,
  couponId: UuidSchema.nullable(),
  couponCode: z.string().nullable(),
  revenueShareBps: RevenueShareBpsSchema,
  instructorShareAmount: MoneyAmountSchema,
  platformShareAmount: MoneyAmountSchema,
});
export type AdminOrderLine = z.infer<typeof AdminOrderLineSchema>;

/** The Checkout Session row. `checkoutUrl` is never exposed here (bearer capability). */
export const AdminPaymentSchema = z.object({
  id: UuidSchema,
  provider: PaymentProviderSchema,
  status: PaymentStatusSchema,
  amount: MoneyAmountSchema,
  currency: CurrencySchema,
  checkoutSessionId: z.string().nullable(),
  paymentIntentId: z.string().nullable(),
  sessionExpiresAt: IsoDateTimeSchema.nullable(),
  succeededAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type AdminPayment = z.infer<typeof AdminPaymentSchema>;

export const OrderTransitionSchema = z.object({
  id: UuidSchema,
  fromStatus: OrderStatusSchema.nullable(),
  toStatus: OrderStatusSchema,
  cause: OrderTransitionCauseSchema,
  providerEventId: z.string().nullable(),
  actorId: UuidSchema.nullable(),
  /** Required for ADMIN transitions. */
  reason: z.string().nullable(),
  occurredAt: IsoDateTimeSchema,
});
export type OrderTransition = z.infer<typeof OrderTransitionSchema>;

/** A webhook (or reconciler) event recorded for the order. No payload is stored (PII, §6). */
export const ProviderEventRecordSchema = z.object({
  provider: PaymentProviderSchema,
  eventId: z.string(),
  type: z.string(),
  livemode: z.boolean(),
  objectId: z.string(),
  providerCreatedAt: IsoDateTimeSchema,
  receivedAt: IsoDateTimeSchema,
  processedAt: IsoDateTimeSchema.nullable(),
  outcome: ProviderEventOutcomeSchema.nullable(),
});
export type ProviderEventRecord = z.infer<typeof ProviderEventRecordSchema>;

/** A refund with the operational fields admins need. */
export const AdminRefundSchema = RefundSchema.extend({
  userId: UuidSchema,
  requestedBy: UuidSchema.nullable(),
  providerRefundId: z.string().nullable(),
  failureCode: z.string().nullable(),
});
export type AdminRefund = z.infer<typeof AdminRefundSchema>;

export const AdminOrderDetailSchema = z.object({
  id: UuidSchema,
  orderNumber: OrderNumberSchema,
  status: OrderStatusSchema,
  currency: CurrencySchema,
  subtotalAmount: MoneyAmountSchema,
  discountAmount: MoneyAmountSchema,
  totalAmount: MoneyAmountSchema,
  refundedAmount: MoneyAmountSchema,
  settlement: OrderSettlementProviderSchema,
  placedAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  buyer: AdminBuyerSchema.nullable(),
  lines: z.array(AdminOrderLineSchema).min(1),
  /** Null for a zero-total order. */
  payment: AdminPaymentSchema.nullable(),
  /** Oldest first. */
  transitions: z.array(OrderTransitionSchema),
  refunds: z.array(AdminRefundSchema),
  /** Oldest first. */
  providerEvents: z.array(ProviderEventRecordSchema),
});
export type AdminOrderDetail = z.infer<typeof AdminOrderDetailSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /admin/orders/:orderId/refunds -> 201 Refund[] (P `order:refund:any`; 404, 409
 *   refund_already_requested, 422). APPROVED per line, ignores the window (§5 AdminRefund).
 * POST /admin/orders/:orderId/accept-payment -> 200 AdminOrderDetail (PAYMENT_REVIEW → PAID;
 *   404, 409 invalid_state_transition).
 * -------------------------------------------------------------------------------------- */

export const ADMIN_REFUND_MAX_LINES = 20;

export const AdminRefundOrderLinesRequestSchema = z.object({
  orderLineIds: z
    .array(UuidSchema)
    .min(1)
    .max(ADMIN_REFUND_MAX_LINES)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Ids must be unique' }),
  reason: AdminMoneyReasonSchema,
});
export type AdminRefundOrderLinesRequest = z.output<typeof AdminRefundOrderLinesRequestSchema>;

export const AdminRefundOrderLinesResponseSchema = z.array(AdminRefundSchema);
export type AdminRefundOrderLinesResponse = z.infer<typeof AdminRefundOrderLinesResponseSchema>;

export const AcceptPaymentRequestSchema = z.object({ reason: AdminMoneyReasonSchema });
export type AcceptPaymentRequest = z.output<typeof AcceptPaymentRequestSchema>;

export const AcceptPaymentResponseSchema = AdminOrderDetailSchema;
export type AcceptPaymentResponse = AdminOrderDetail;

/* ----------------------------------------------------------------------------------------
 * GET /admin/refunds?status=REQUESTED|FAILED&cursor=&limit= -> 200 AdminRefundQueuePage
 *   (P `refund:review:any`). Oldest first (createdAt, id); `status` defaults to REQUESTED.
 * POST /admin/refunds/:refundId/approve -> 200 AdminRefundQueueItem (REQUESTED → APPROVED)
 * POST /admin/refunds/:refundId/reject  -> 200 AdminRefundQueueItem (REQUESTED → REJECTED)
 * POST /admin/refunds/:refundId/retry   -> 200 AdminRefundQueueItem (FAILED → APPROVED, attempt+1)
 *   404 refund_not_found, 409 invalid_state_transition, 422.
 * -------------------------------------------------------------------------------------- */

export const REFUND_QUEUE_STATUSES = ['REQUESTED', 'FAILED'] as const satisfies readonly z.infer<
  typeof RefundStatusSchema
>[];
export const RefundQueueStatusSchema = z.enum(REFUND_QUEUE_STATUSES);
export type RefundQueueStatus = z.infer<typeof RefundQueueStatusSchema>;

export const AdminRefundsQuerySchema = PaginationQuerySchema.extend({
  status: z.preprocess(emptyToUndefined, RefundQueueStatusSchema.default('REQUESTED')),
});
export type AdminRefundsQuery = z.output<typeof AdminRefundsQuerySchema>;

export const AdminRefundQueueItemSchema = AdminRefundSchema.extend({
  orderNumber: OrderNumberSchema,
  buyer: AdminBuyerSchema.nullable(),
  /** The buyer's refunds in the last 90 days (≥ 3 sends a request to review, D11). */
  recentRefundCount: z.number().int().min(0),
});
export type AdminRefundQueueItem = z.infer<typeof AdminRefundQueueItemSchema>;

export const AdminRefundQueuePageSchema = pageSchema(AdminRefundQueueItemSchema);
export type AdminRefundQueuePage = z.infer<typeof AdminRefundQueuePageSchema>;

export const RefundIdParamsSchema = z.object({ refundId: UuidSchema });
export type RefundIdParams = z.output<typeof RefundIdParamsSchema>;

/** Optional note on approve and retry (stored on the transition). */
export const ApproveRefundRequestSchema = z.object({ reason: multilineText(1, 2000).optional() });
export type ApproveRefundRequest = z.output<typeof ApproveRefundRequestSchema>;

/** Required on reject (mailed to the student): 10–2000. */
export const RejectRefundRequestSchema = z.object({ reason: AdminMoneyReasonSchema });
export type RejectRefundRequest = z.output<typeof RejectRefundRequestSchema>;

export const RetryRefundRequestSchema = ApproveRefundRequestSchema;
export type RetryRefundRequest = ApproveRefundRequest;

export const RefundDecisionResponseSchema = AdminRefundQueueItemSchema;
export type RefundDecisionResponse = AdminRefundQueueItem;
