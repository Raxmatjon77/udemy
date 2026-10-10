import { Module } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  StripePaymentProvider,
  validateStripeProviderConfig,
} from '@udemy/payments';
import { AppConfigService } from '../../shared/config';
import { CatalogModule } from '../catalog';
import { EnrollmentModule } from '../enrollment';
import { IdentityModule } from '../identity';
import { CartQuoteService } from './application/cart-quote.service';
import { CheckoutSessions } from './application/checkout-sessions.service';
import { CommerceJobs } from './application/commerce-jobs';
import { CommerceSettings } from './application/commerce-settings';
import { CreatingPaymentAbandoner } from './application/creating-payment-abandoner.service';
import { AdminOrderViews } from './application/admin-order-views.service';
import { EnrollmentFacadeGateway } from './application/enrollment-facade.gateway';
import {
  CatalogFacadeGateway,
  IdentityFacadeAdminDirectory,
  IdentityFacadeBuyers,
  IdentityFacadePeople,
} from './application/facade-gateways';
import { OrderLifecycle } from './application/order-lifecycle.service';
import { OrderViews } from './application/order-views.service';
import { OrderOwnership } from './application/order.ownership';
import { AdminOrderRepository } from './application/ports/admin-order.repository';
import { CartRepository } from './application/ports/cart.repository';
import { CommerceClock } from './application/ports/commerce-clock';
import { CommerceEventPublisher } from './application/ports/commerce-event.publisher';
import { CommerceRateLimiter } from './application/ports/commerce-rate-limiter';
import {
  CommerceAdminDirectory,
  CommerceBuyers,
  CommerceCatalog,
  CommerceEnrollments,
  CommercePeople,
} from './application/ports/context-gateways';
import { CouponRepository } from './application/ports/coupon.repository';
import { OrderOwnerReader } from './application/ports/order-owner.reader';
import { OrderRepository } from './application/ports/order.repository';
import { PricingRepository } from './application/ports/pricing.repository';
import { ProviderEventInbox } from './application/ports/provider-event.inbox';
import {
  ProviderRefundEvents,
  RefundDispatchTrigger,
} from './application/ports/provider-refund-events';
import { ReconcileRepository } from './application/ports/reconcile.repository';
import {
  NoConsumptionData,
  RefundEligibilityPolicy,
} from './application/ports/refund-eligibility.policy';
import { RefundDispatchRepository, RefundRepository } from './application/ports/refund.repository';
import { SalesRepository } from './application/ports/sales.repository';
import { ProviderRefundEventsHandler } from './application/provider-refund-events.handler';
import { TransactionRunner } from './application/ports/transaction-runner';
import { PurchaseEligibilityChecker } from './application/purchase-eligibility.checker';
import { RefundDispatcher, RefundDispatchKick } from './application/refund-dispatcher.service';
import { RefundLifecycle } from './application/refund-lifecycle.service';
import { AcceptPaymentCommand } from './application/use-cases/accept-payment.command';
import { AddToCartCommand } from './application/use-cases/add-to-cart.command';
import { AdminRefundOrderLinesCommand } from './application/use-cases/admin-refund-order-lines.command';
import { ApplyCouponCommand } from './application/use-cases/apply-coupon.command';
import { CancelPendingOrderCommand } from './application/use-cases/cancel-pending-order.command';
import { CheckoutCommand } from './application/use-cases/checkout.command';
import { CreateCourseCouponCommand } from './application/use-cases/create-course-coupon.command';
import { CreatePlatformCouponCommand } from './application/use-cases/create-platform-coupon.command';
import { DeactivateCouponCommand } from './application/use-cases/deactivate-coupon.command';
import { GetAdminOrderQuery } from './application/use-cases/get-admin-order.query';
import { GetCartQuery } from './application/use-cases/get-cart.query';
import { GetCoursePricingQuery } from './application/use-cases/get-course-pricing.query';
import { GetMyOrderQuery } from './application/use-cases/get-my-order.query';
import { GetPublicPricesQuery } from './application/use-cases/get-public-prices.query';
import { GetPurchaseStatesQuery } from './application/use-cases/get-purchase-states.query';
import { GetReceiptQuery } from './application/use-cases/get-receipt.query';
import { HandleProviderEventCommand } from './application/use-cases/handle-provider-event.command';
import {
  GetSalesSummaryQuery,
  ListRecentSalesQuery,
} from './application/use-cases/instructor-sales.queries';
import { ListCouponsQuery } from './application/use-cases/list-coupons.query';
import { ListMyOrdersQuery } from './application/use-cases/list-my-orders.query';
import { ListRefundQueueQuery } from './application/use-cases/list-refund-queue.query';
import { MergeGuestCartCommand } from './application/use-cases/merge-guest-cart.command';
import { RemoveCouponCommand } from './application/use-cases/remove-coupon.command';
import { RemoveFromCartCommand } from './application/use-cases/remove-from-cart.command';
import { RequestRefundCommand } from './application/use-cases/request-refund.command';
import { ReviewRefundCommand } from './application/use-cases/review-refund.command';
import { SearchAdminOrdersQuery } from './application/use-cases/search-admin-orders.query';
import { SetCoursePriceCommand } from './application/use-cases/set-course-price.command';
import { CommerceJobsScheduler } from './infrastructure/commerce-jobs.scheduler';
import { DatabaseCommerceClock } from './infrastructure/database-commerce-clock';
import { KyselyAdminOrderRepository } from './infrastructure/kysely-admin-order.repository';
import { KyselyCartRepository } from './infrastructure/kysely-cart.repository';
import { KyselyCouponRepository } from './infrastructure/kysely-coupon.repository';
import { KyselyOrderOwnerReader } from './infrastructure/kysely-order-owner.reader';
import { KyselyOrderRepository } from './infrastructure/kysely-order.repository';
import { KyselyPricingRepository } from './infrastructure/kysely-pricing.repository';
import { KyselyProviderEventInbox } from './infrastructure/kysely-provider-event.inbox';
import { KyselyReconcileRepository } from './infrastructure/kysely-reconcile.repository';
import {
  KyselyRefundDispatchRepository,
  KyselyRefundRepository,
} from './infrastructure/kysely-refund.repository';
import { KyselySalesRepository } from './infrastructure/kysely-sales.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { OutboxCommerceEventPublisher } from './infrastructure/outbox-commerce-event.publisher';
import { RedisCommerceRateLimiter } from './infrastructure/redis-commerce-rate-limiter';
import { AdminCouponsController } from './presentation/admin-coupons.controller';
import { AdminOrdersController } from './presentation/admin-orders.controller';
import { AdminRefundsController } from './presentation/admin-refunds.controller';
import { CartController } from './presentation/cart.controller';
import { CheckoutController } from './presentation/checkout.controller';
import { CourseCouponsController } from './presentation/course-coupons.controller';
import { CoursePricingController } from './presentation/course-pricing.controller';
import { InstructorSalesController } from './presentation/instructor-sales.controller';
import { MyOrdersController } from './presentation/my-orders.controller';
import { PublicPricesController } from './presentation/public-prices.controller';
import { StripeSignatureGuard } from './presentation/stripe-signature.guard';
import { StripeWebhookController } from './presentation/stripe-webhook.controller';

/**
 * `PAYMENT_PROVIDER` (design §14): the real Stripe adapter, configured from the validated env.
 * `STRIPE_API_BASE_URL` points it at apps/stripe-emulator or stripe-mock (dev, CI); live keys
 * are refused by the env schema and again by the adapter.
 */
export function stripeProviderFrom(config: AppConfigService): PaymentProvider {
  const apiBaseUrl = config.get('STRIPE_API_BASE_URL');
  return new StripePaymentProvider(
    validateStripeProviderConfig({
      secretKey: config.get('STRIPE_SECRET_KEY'),
      ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    }),
  );
}

/** `CommerceSettings` from the validated `COMMERCE_*` / `STRIPE_*` env. */
export function commerceSettingsFrom(config: AppConfigService): CommerceSettings {
  return CommerceSettings.fromEnv({
    COMMERCE_CURRENCY: config.get('COMMERCE_CURRENCY'),
    COMMERCE_CART_MAX_ITEMS: config.get('COMMERCE_CART_MAX_ITEMS'),
    COMMERCE_INSTRUCTOR_SHARE_BPS: config.get('COMMERCE_INSTRUCTOR_SHARE_BPS'),
    COMMERCE_CHECKOUT_SESSION_TTL_MIN: config.get('COMMERCE_CHECKOUT_SESSION_TTL_MIN'),
    COMMERCE_REFUND_WINDOW_DAYS: config.get('COMMERCE_REFUND_WINDOW_DAYS'),
    COMMERCE_JOBS_ENABLED: config.get('COMMERCE_JOBS_ENABLED'),
    COMMERCE_RECONCILE_INTERVAL_MS: config.get('COMMERCE_RECONCILE_INTERVAL_MS'),
    COMMERCE_REFUND_DISPATCH_INTERVAL_MS: config.get('COMMERCE_REFUND_DISPATCH_INTERVAL_MS'),
    STUDENT_APP_ORIGIN: config.get('STUDENT_APP_ORIGIN'),
    CHECKOUT_ALLOWED_ORIGINS: config.get('CHECKOUT_ALLOWED_ORIGINS'),
    STRIPE_API_BASE_URL: config.get('STRIPE_API_BASE_URL'),
    STRIPE_WEBHOOK_SECRET: config.get('STRIPE_WEBHOOK_SECRET'),
    STRIPE_WEBHOOK_TOLERANCE_S: config.get('STRIPE_WEBHOOK_TOLERANCE_S'),
  });
}

/**
 * The commerce context (design §3–§9).
 *
 * - Part A (P4-T13): money/price-tier/coupon/quote domain, instructor and public pricing, the
 *   server cart + guest-cart merge, course and platform coupons, the quote, purchase states,
 *   the `order` ownership resolver and the commerce rate limits.
 * - Part B (P4-T15): checkout (tx A / provider / tx B, resume by Idempotency-Key, zero-total
 *   orders), cancel, the Stripe webhook (`StripeSignatureGuard` + `HandleProviderEvent`), the
 *   buyer's orders and receipt, and `CommerceJobs.reconcile` on a timer.
 *
 * Depends on catalog (`CatalogFacade`: live course summaries), enrollment (`EnrollmentFacade`:
 * active enrollments; grant in the PAID transaction, D8) and identity (`IdentityFacade`: names,
 * the buyer's verified email), each behind a commerce-side port; on `@udemy/payments`
 * (`PAYMENT_PROVIDER`, the only Stripe client, D9); plus the global DatabaseModule,
 * OutboxModule, RedisModule, AuthSupportModule, AppConfigModule and ScheduleModule.
 *
 * - Part C (P4-T16): refunds (student request with the D11 auto-approve rule, admin refund,
 *   review, retry), `CommerceJobs.dispatchRefunds` (`RefundDispatcher`, advisory lock `_03`,
 *   provider call outside any transaction, fenced) with the post-commit kick
 *   (`RefundDispatchTrigger`), the refund webhooks (`ProviderRefundEvents`), PAYMENT_REVIEW
 *   accept, admin order search / detail / refund queue, and instructor sales.
 *
 * Exports nothing: no other module calls commerce in Phase 4 (design §3).
 */
@Module({
  imports: [CatalogModule, EnrollmentModule, IdentityModule],
  controllers: [
    PublicPricesController,
    CoursePricingController,
    CourseCouponsController,
    CartController,
    AdminCouponsController,
    CheckoutController,
    MyOrdersController,
    StripeWebhookController,
    AdminOrdersController,
    AdminRefundsController,
    InstructorSalesController,
  ],
  providers: [
    // Configuration and time
    { provide: CommerceSettings, inject: [AppConfigService], useFactory: commerceSettingsFrom },
    { provide: CommerceClock, useClass: DatabaseCommerceClock },

    // Other contexts, behind commerce-side ports
    { provide: CommerceCatalog, useClass: CatalogFacadeGateway },
    { provide: CommerceEnrollments, useClass: EnrollmentFacadeGateway },
    { provide: CommercePeople, useClass: IdentityFacadePeople },
    { provide: CommerceBuyers, useClass: IdentityFacadeBuyers },
    { provide: CommerceAdminDirectory, useClass: IdentityFacadeAdminDirectory },

    // The payment provider (the only Stripe client, D9)
    { provide: PAYMENT_PROVIDER, inject: [AppConfigService], useFactory: stripeProviderFrom },

    // Persistence, events, limits
    { provide: TransactionRunner, useClass: KyselyTransactionRunner },
    { provide: PricingRepository, useClass: KyselyPricingRepository },
    { provide: CartRepository, useClass: KyselyCartRepository },
    { provide: CouponRepository, useClass: KyselyCouponRepository },
    { provide: OrderOwnerReader, useClass: KyselyOrderOwnerReader },
    { provide: CommerceEventPublisher, useClass: OutboxCommerceEventPublisher },
    { provide: CommerceRateLimiter, useClass: RedisCommerceRateLimiter },
    { provide: OrderRepository, useClass: KyselyOrderRepository },
    { provide: ProviderEventInbox, useClass: KyselyProviderEventInbox },
    { provide: ReconcileRepository, useClass: KyselyReconcileRepository },
    { provide: RefundRepository, useClass: KyselyRefundRepository },
    { provide: RefundDispatchRepository, useClass: KyselyRefundDispatchRepository },
    { provide: AdminOrderRepository, useClass: KyselyAdminOrderRepository },
    { provide: SalesRepository, useClass: KyselySalesRepository },

    // Refunds (P4-T16): webhooks, dispatcher kick, the Phase 5 consumption seam
    { provide: ProviderRefundEvents, useClass: ProviderRefundEventsHandler },
    { provide: RefundDispatchTrigger, useClass: RefundDispatchKick },
    { provide: RefundEligibilityPolicy, useClass: NoConsumptionData },
    RefundLifecycle,
    RefundDispatcher,

    // Application services; OrderOwnership is discovered by access's OwnershipRegistry
    CartQuoteService,
    PurchaseEligibilityChecker,
    OrderOwnership,
    OrderLifecycle,
    OrderViews,
    CheckoutSessions,
    CreatingPaymentAbandoner,
    AdminOrderViews,
    StripeSignatureGuard,

    // Use cases: pricing
    GetCoursePricingQuery,
    SetCoursePriceCommand,
    GetPublicPricesQuery,

    // Use cases: cart, quote, purchase states
    GetCartQuery,
    AddToCartCommand,
    RemoveFromCartCommand,
    MergeGuestCartCommand,
    ApplyCouponCommand,
    RemoveCouponCommand,
    GetPurchaseStatesQuery,

    // Use cases: coupons
    ListCouponsQuery,
    CreateCourseCouponCommand,
    CreatePlatformCouponCommand,
    DeactivateCouponCommand,

    // Use cases: checkout, orders, webhook
    CheckoutCommand,
    CancelPendingOrderCommand,
    ListMyOrdersQuery,
    GetMyOrderQuery,
    GetReceiptQuery,
    HandleProviderEventCommand,

    // Use cases: refunds, admin orders, instructor sales (P4-T16)
    RequestRefundCommand,
    AdminRefundOrderLinesCommand,
    ReviewRefundCommand,
    AcceptPaymentCommand,
    ListRefundQueueQuery,
    SearchAdminOrdersQuery,
    GetAdminOrderQuery,
    GetSalesSummaryQuery,
    ListRecentSalesQuery,

    // Jobs
    CommerceJobs,
    CommerceJobsScheduler,
  ],
})
export class CommerceModule {}
