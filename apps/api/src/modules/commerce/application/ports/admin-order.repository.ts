import type {
  OrderStatus,
  OrderTransitionCause,
  PaymentStatus,
  ProviderEventOutcome,
} from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import type { OrderKeyset } from './order.repository';

export interface AdminOrderFilter {
  readonly orderNumber?: number;
  readonly status?: OrderStatus;
  readonly userId?: string;
  /** Buyers matched by email (an empty list matches nothing). */
  readonly userIdIn?: readonly string[];
  readonly courseId?: string;
  /** `placed_at >= from`. */
  readonly from?: Date;
  /** `placed_at < to`. */
  readonly to?: Date;
}

export interface AdminOrderRowRecord {
  readonly id: string;
  readonly orderNumber: number;
  readonly userId: string;
  readonly status: OrderStatus;
  readonly currency: string;
  readonly totalAmount: string;
  readonly lineCount: number;
  readonly placedAt: Date;
  readonly paidAt: Date | null;
  readonly keyset: OrderKeyset;
}

export interface AdminOrderLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly instructorId: string;
  readonly listAmount: string;
  readonly discountAmount: string;
  readonly finalAmount: string;
  readonly couponId: string | null;
  readonly couponCode: string | null;
  readonly revenueShareBps: number;
  readonly instructorShareAmount: string;
  readonly platformShareAmount: string;
}

export interface AdminPaymentRecord {
  readonly status: PaymentStatus;
  readonly amount: string;
  readonly currency: string;
  readonly checkoutSessionId: string | null;
  readonly paymentIntentId: string | null;
  readonly sessionExpiresAt: Date | null;
  readonly succeededAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrderTransitionRecord {
  readonly seq: number;
  readonly fromStatus: OrderStatus | null;
  readonly toStatus: OrderStatus;
  readonly cause: OrderTransitionCause;
  readonly providerEventId: string | null;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export interface ProviderEventRecord {
  readonly eventId: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly objectId: string | null;
  readonly providerCreatedAt: Date;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly outcome: ProviderEventOutcome | null;
}

export interface AdminOrderParts {
  /** In `line_no` order. */
  readonly lines: readonly AdminOrderLineRecord[];
  readonly payment: AdminPaymentRecord | null;
  /** Oldest first. */
  readonly transitions: readonly OrderTransitionRecord[];
  /** Oldest first (`received_at`). */
  readonly providerEvents: readonly ProviderEventRecord[];
}

/** Admin order reads (design §8 `GET /admin/orders`, `/admin/orders/:orderId`). */
export abstract class AdminOrderRepository {
  /** Newest first `(placed_at DESC, id DESC)`; every filter is ANDed. */
  abstract search(
    filter: AdminOrderFilter,
    page: { readonly after?: OrderKeyset; readonly limit: number },
    ex?: Executor,
  ): Promise<AdminOrderRowRecord[]>;

  abstract findParts(orderId: string, ex?: Executor): Promise<AdminOrderParts>;
}
