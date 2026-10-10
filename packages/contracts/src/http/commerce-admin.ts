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
 * GET /admin/orders?q=&buyerEmail=&status=&userId=&courseId=&from=&to=&cursor=&limit=
 *   -> 200 AdminOrderPage (P `order:read:any`; 400). Keyset (placedAt DESC, id DESC).
 * `q` is an order number (a leading `#` is not accepted; strip it in the UI). All filters
 * combine with AND.
 * -------------------------------------------------------------------------------------- */

/** `buyerEmail` bounds: a case-insensitive substring of the buyer's email (P4-T16). */
export const ADMIN_ORDER_BUYER_EMAIL_MIN = 3;
/** At most this many matching accounts are searched (the most recently created first). */
export const ADMIN_ORDER_BUYER_MATCH_LIMIT = 200;

export const AdminOrdersQuerySchema = PaginationQuerySchema.extend({
  q: z.preprocess(emptyToUndefined, z.coerce.number().pipe(OrderNumberSchema).optional()),
  /**
   * Additive (P4-T16): orders of buyers whose email CONTAINS this text (case-insensitive,
   * 3–254 characters, e.g. `jane@` or `@example.com`). Matched against at most
   * `ADMIN_ORDER_BUYER_MATCH_LIMIT` accounts; no match is an empty page, not an error.
   */
  buyerEmail: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(ADMIN_ORDER_BUYER_EMAIL_MIN).max(254).optional(),
  ),
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

/**
 * Who made a transition, resolved live for display (admin app only, so banned accounts are
 * shown too). Null for system transitions (webhook, reconciler, dispatcher) and for accounts
 * that no longer exist.
 */
export const AdminActorSchema = PersonRefSchema;
export type AdminActor = z.infer<typeof AdminActorSchema>;

export const OrderTransitionSchema = z.object({
  id: UuidSchema,
  fromStatus: OrderStatusSchema.nullable(),
  toStatus: OrderStatusSchema,
  cause: OrderTransitionCauseSchema,
  providerEventId: z.string().nullable(),
  actorId: UuidSchema.nullable(),
  /** Additive (P4-T16): the actor's display name; null when `actorId` is null or unknown. */
  actor: AdminActorSchema.nullable(),
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

/** One row of a refund's append-only log (`commerce.refund_transitions`), oldest first. */
export const RefundTransitionSchema = z.object({
  seq: z.number().int().min(1),
  fromStatus: RefundStatusSchema.nullable(),
  toStatus: RefundStatusSchema,
  /** The admin (review, retry, admin refund) or the student (request); null for the system. */
  actorId: UuidSchema.nullable(),
  actor: AdminActorSchema.nullable(),
  /** The admin's reason (required on REJECTED and on admin refunds' first row). */
  reason: z.string().nullable(),
  /** This attempt's provider refund (SUBMITTED / SUCCEEDED / FAILED rows). */
  providerRefundId: z.string().nullable(),
  failureCode: z.string().nullable(),
  /** The webhook event that caused it; null for the dispatcher and admin actions. */
  providerEventId: z.string().nullable(),
  occurredAt: IsoDateTimeSchema,
});
export type RefundTransition = z.infer<typeof RefundTransitionSchema>;

/** A refund of the order with its full log (P4-T16, additive over `AdminRefund`). */
export const AdminOrderRefundSchema = AdminRefundSchema.extend({
  transitions: z.array(RefundTransitionSchema),
});
export type AdminOrderRefund = z.infer<typeof AdminOrderRefundSchema>;

export const ADMIN_ORDER_TIMELINE_KINDS = ['ORDER', 'PAYMENT', 'REFUND'] as const;
export const AdminOrderTimelineKindSchema = z.enum(ADMIN_ORDER_TIMELINE_KINDS);
export type AdminOrderTimelineKind = z.infer<typeof AdminOrderTimelineKindSchema>;

/**
 * One entry of the merged order timeline (P4-T16): order transitions, payment milestones
 * (CREATING at creation, SUCCEEDED at capture, EXPIRED / ABANDONED when closed) and every
 * refund transition, oldest first (ties: ORDER, PAYMENT, REFUND). `fromStatus` / `toStatus`
 * are statuses of the entry's `kind`.
 */
export const AdminOrderTimelineEntrySchema = z.object({
  kind: AdminOrderTimelineKindSchema,
  at: IsoDateTimeSchema,
  /** REFUND entries: the refund. */
  refundId: UuidSchema.nullable(),
  fromStatus: z.union([OrderStatusSchema, PaymentStatusSchema, RefundStatusSchema]).nullable(),
  toStatus: z.union([OrderStatusSchema, PaymentStatusSchema, RefundStatusSchema]),
  /** ORDER entries: the transition cause. */
  cause: OrderTransitionCauseSchema.nullable(),
  actorId: UuidSchema.nullable(),
  actor: AdminActorSchema.nullable(),
  reason: z.string().nullable(),
  providerEventId: z.string().nullable(),
  providerRefundId: z.string().nullable(),
  failureCode: z.string().nullable(),
});
export type AdminOrderTimelineEntry = z.infer<typeof AdminOrderTimelineEntrySchema>;

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
  /** Oldest first, each with its own log (additive, P4-T16). */
  refunds: z.array(AdminOrderRefundSchema),
  /** Oldest first. */
  providerEvents: z.array(ProviderEventRecordSchema),
  /** Order + payment + refund history merged, oldest first (additive, P4-T16). */
  timeline: z.array(AdminOrderTimelineEntrySchema),
});
export type AdminOrderDetail = z.infer<typeof AdminOrderDetailSchema>;

/* ----------------------------------------------------------------------------------------
 * POST /admin/orders/:orderId/refunds -> 201 Refund[] (P `order:refund:any`; 404, 409
 *   refund_already_requested, 422). APPROVED per line, ignores the window (§5 AdminRefund).
 *   Reason code ADMIN_DISCRETION; on a PAYMENT_REVIEW order every paid line must be listed
 *   (a full refund, reason code PAYMENT_REVIEW; 422 refund_not_applicable otherwise).
 * POST /admin/orders/:orderId/accept-payment -> 200 AdminOrderDetail (PAYMENT_REVIEW → PAID
 *   with enrollments; 404, 409 invalid_state_transition, also when the order has a live or
 *   succeeded refund).
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
 * GET /admin/refunds?status=&cursor=&limit= -> 200 AdminRefundQueuePage
 *   (P `refund:review:any`). Oldest first (createdAt, id); `status` defaults to REQUESTED and
 *   accepts every refund status (P4-T16); REQUESTED and FAILED are the work queues.
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

/** Every status the refund list can be filtered by (additive, P4-T16). */
export const ADMIN_REFUND_FILTER_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
] as const satisfies readonly z.infer<typeof RefundStatusSchema>[];

export const AdminRefundsQuerySchema = PaginationQuerySchema.extend({
  status: z.preprocess(emptyToUndefined, RefundStatusSchema.default('REQUESTED')),
});
export type AdminRefundsQuery = z.output<typeof AdminRefundsQuerySchema>;

export const AdminRefundQueueItemSchema = AdminRefundSchema.extend({
  orderNumber: OrderNumberSchema,
  buyer: AdminBuyerSchema.nullable(),
  /**
   * The D11 abuse count AS THE RULE SAW IT for this refund: the buyer's other STUDENT refunds
   * (any status but REJECTED) created in the `REFUND_REVIEW_LOOKBACK_DAYS` (90) days before
   * this refund was created. `>= REFUND_REVIEW_THRESHOLD` (3) is why a student request is
   * REQUESTED instead of auto-approved. Later refunds never change it; only a later
   * rejection of one of the counted refunds lowers it.
   */
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
