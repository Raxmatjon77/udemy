import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { EnrollmentModule } from '../enrollment';
import { IdentityModule } from '../identity';
import { CartQuoteService } from './application/cart-quote.service';
import { CommerceSettings } from './application/commerce-settings';
import { EnrollmentFacadeGateway } from './application/enrollment-facade.gateway';
import { CatalogFacadeGateway, IdentityFacadePeople } from './application/facade-gateways';
import { OrderOwnership } from './application/order.ownership';
import { CartRepository } from './application/ports/cart.repository';
import { CommerceClock } from './application/ports/commerce-clock';
import { CommerceEventPublisher } from './application/ports/commerce-event.publisher';
import { CommerceRateLimiter } from './application/ports/commerce-rate-limiter';
import {
  CommerceCatalog,
  CommerceEnrollments,
  CommercePeople,
} from './application/ports/context-gateways';
import { CouponRepository } from './application/ports/coupon.repository';
import { OrderOwnerReader } from './application/ports/order-owner.reader';
import { PricingRepository } from './application/ports/pricing.repository';
import { TransactionRunner } from './application/ports/transaction-runner';
import { PurchaseEligibilityChecker } from './application/purchase-eligibility.checker';
import { AddToCartCommand } from './application/use-cases/add-to-cart.command';
import { ApplyCouponCommand } from './application/use-cases/apply-coupon.command';
import { CreateCourseCouponCommand } from './application/use-cases/create-course-coupon.command';
import { CreatePlatformCouponCommand } from './application/use-cases/create-platform-coupon.command';
import { DeactivateCouponCommand } from './application/use-cases/deactivate-coupon.command';
import { GetCartQuery } from './application/use-cases/get-cart.query';
import { GetCoursePricingQuery } from './application/use-cases/get-course-pricing.query';
import { GetPublicPricesQuery } from './application/use-cases/get-public-prices.query';
import { GetPurchaseStatesQuery } from './application/use-cases/get-purchase-states.query';
import { ListCouponsQuery } from './application/use-cases/list-coupons.query';
import { MergeGuestCartCommand } from './application/use-cases/merge-guest-cart.command';
import { RemoveCouponCommand } from './application/use-cases/remove-coupon.command';
import { RemoveFromCartCommand } from './application/use-cases/remove-from-cart.command';
import { SetCoursePriceCommand } from './application/use-cases/set-course-price.command';
import { DatabaseCommerceClock } from './infrastructure/database-commerce-clock';
import { KyselyCartRepository } from './infrastructure/kysely-cart.repository';
import { KyselyCouponRepository } from './infrastructure/kysely-coupon.repository';
import { KyselyOrderOwnerReader } from './infrastructure/kysely-order-owner.reader';
import { KyselyPricingRepository } from './infrastructure/kysely-pricing.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { OutboxCommerceEventPublisher } from './infrastructure/outbox-commerce-event.publisher';
import { RedisCommerceRateLimiter } from './infrastructure/redis-commerce-rate-limiter';
import { AdminCouponsController } from './presentation/admin-coupons.controller';
import { CartController } from './presentation/cart.controller';
import { CourseCouponsController } from './presentation/course-coupons.controller';
import { CoursePricingController } from './presentation/course-pricing.controller';
import { PublicPricesController } from './presentation/public-prices.controller';

/**
 * commerce, part A (design §3–§9, P4-T13): money/price-tier/coupon/quote domain, instructor and
 * public pricing, the server cart + guest-cart merge, course and platform coupons, the quote,
 * purchase states, the `order` ownership resolver and the commerce rate limits.
 *
 * Depends on catalog (`CatalogFacade`: live course summaries), enrollment (`EnrollmentFacade`:
 * active enrollments now; grant/revoke for checkout and refunds) and identity
 * (`IdentityFacade`: instructor names), each behind a commerce-side port; plus the global
 * DatabaseModule, OutboxModule, RedisModule and AuthSupportModule. Pricing and coupon routes
 * use catalog's `course` ownership resolver through `@CheckPolicy`.
 *
 * Extension points for P4-T15/T16 (checkout, webhook, orders, refunds, reconcile): the domain
 * (`Money`, `CouponTerms`, `assembleQuote`/`quoteFingerprint`), `CartQuoteService` (re-quote
 * inside checkout after the locks), the repositories, `TransactionRunner` (READ COMMITTED,
 * commit-time constraint mapping), `COMMERCE_CONSTRAINT_ERRORS`, `CommerceEventPublisher`,
 * `CommerceRateLimiter.hitCheckout`/`hitRefundRequest`, `CommerceEnrollments.grant`/`revoke`,
 * `OrderOwnership` and `CommerceSettings`.
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
  ],
  providers: [
    // Configuration and time
    { provide: CommerceSettings, useFactory: () => CommerceSettings.defaults() },
    { provide: CommerceClock, useClass: DatabaseCommerceClock },

    // Other contexts, behind commerce-side ports
    { provide: CommerceCatalog, useClass: CatalogFacadeGateway },
    { provide: CommerceEnrollments, useClass: EnrollmentFacadeGateway },
    { provide: CommercePeople, useClass: IdentityFacadePeople },

    // Persistence, events, limits
    { provide: TransactionRunner, useClass: KyselyTransactionRunner },
    { provide: PricingRepository, useClass: KyselyPricingRepository },
    { provide: CartRepository, useClass: KyselyCartRepository },
    { provide: CouponRepository, useClass: KyselyCouponRepository },
    { provide: OrderOwnerReader, useClass: KyselyOrderOwnerReader },
    { provide: CommerceEventPublisher, useClass: OutboxCommerceEventPublisher },
    { provide: CommerceRateLimiter, useClass: RedisCommerceRateLimiter },

    // Application services; OrderOwnership is discovered by access's OwnershipRegistry
    CartQuoteService,
    PurchaseEligibilityChecker,
    OrderOwnership,

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
  ],
})
export class CommerceModule {}
