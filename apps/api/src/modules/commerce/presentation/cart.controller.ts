import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type ApplyCouponRequest,
  ApplyCouponRequestSchema,
  type CartItemParams,
  CartItemParamsSchema,
  type CartQuote,
  CartQuoteSchema,
  type MergeGuestCartRequest,
  MergeGuestCartRequestSchema,
  type MergeGuestCartResponse,
  MergeGuestCartResponseSchema,
  type PurchaseStatesQuery,
  PurchaseStatesQuerySchema,
  type PurchaseStatesResponse,
  PurchaseStatesResponseSchema,
} from '@udemy/contracts';
import {
  type ClientContext,
  CurrentClient,
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '../../../shared/auth';
import { AddToCartCommand } from '../application/use-cases/add-to-cart.command';
import { ApplyCouponCommand } from '../application/use-cases/apply-coupon.command';
import { GetCartQuery } from '../application/use-cases/get-cart.query';
import { GetPurchaseStatesQuery } from '../application/use-cases/get-purchase-states.query';
import { MergeGuestCartCommand } from '../application/use-cases/merge-guest-cart.command';
import { RemoveCouponCommand } from '../application/use-cases/remove-coupon.command';
import { RemoveFromCartCommand } from '../application/use-cases/remove-from-cart.command';

const COUPON_422 =
  'coupon_invalid (unknown, or no cart line it applies to) / coupon_expired / coupon_not_started / ' +
  'coupon_exhausted / coupon_already_used';

/**
 * `/api/v1/me/cart` and `/api/v1/me/purchase-states` (design §8, student BFF). The server
 * cart exists for signed-in users only (D4); every write answers the fresh quote. Request
 * bodies never carry a price (§9 price tampering).
 */
@ApiTags('commerce')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('me')
export class CartController {
  constructor(
    private readonly getCart: GetCartQuery,
    private readonly addToCart: AddToCartCommand,
    private readonly removeFromCart: RemoveFromCartCommand,
    private readonly mergeGuestCart: MergeGuestCartCommand,
    private readonly applyCoupon: ApplyCouponCommand,
    private readonly removeCoupon: RemoveCouponCommand,
    private readonly purchaseStates: GetPurchaseStatesQuery,
  ) {}

  @Get('cart')
  @RequirePermissions('cart:manage')
  @ApiOperation({
    summary: 'My cart, priced (the quote)',
    description:
      'Lines with the current price and the best coupon per line, unavailable items with a ' +
      'reason, totals and the fingerprint. A coupon code that no longer applies is reported.',
  })
  @ApiOkResponse({ standardSchema: CartQuoteSchema })
  get(@CurrentPrincipal() principal: Principal): Promise<CartQuote> {
    return this.getCart.execute(principal.userId);
  }

  @Put('cart/items/:courseId')
  @RequirePermissions('cart:manage')
  @ApiOperation({ summary: 'Add a course to my cart (adding twice is a 200)' })
  @ApiOkResponse({ standardSchema: CartQuoteSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  @ApiConflictResponse({
    description:
      'course_not_for_sale / course_is_free / cannot_purchase_own_course / already_enrolled',
  })
  @ApiUnprocessableEntityResponse({ description: 'cart_full' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  addItem(
    @Param({ schema: CartItemParamsSchema }) params: CartItemParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CartQuote> {
    return this.addToCart.execute({ userId: principal.userId, courseId: params.courseId });
  }

  @Delete('cart/items/:courseId')
  @RequirePermissions('cart:manage')
  @ApiOperation({ summary: 'Remove a course from my cart (idempotent)' })
  @ApiOkResponse({ standardSchema: CartQuoteSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  removeItem(
    @Param({ schema: CartItemParamsSchema }) params: CartItemParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CartQuote> {
    return this.removeFromCart.execute({ userId: principal.userId, courseId: params.courseId });
  }

  @Post('cart/merge')
  @RequirePermissions('cart:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Merge the guest cart after login (best effort)',
    description: 'Eligible ids are added; the others are reported in `skipped` with a reason.',
  })
  @ApiOkResponse({ standardSchema: MergeGuestCartResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  merge(
    @Body({ schema: MergeGuestCartRequestSchema }) body: MergeGuestCartRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MergeGuestCartResponse> {
    return this.mergeGuestCart.execute({ userId: principal.userId, courseIds: body.courseIds });
  }

  @Put('cart/coupon')
  @RequirePermissions('cart:manage')
  @ApiOperation({
    summary: 'Apply a coupon code to my cart (one code per cart)',
    description: 'Rate-limited per user and per IP; every attempt counts.',
  })
  @ApiOkResponse({ standardSchema: CartQuoteSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: COUPON_422 })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  setCoupon(
    @Body({ schema: ApplyCouponRequestSchema }) body: ApplyCouponRequest,
    @CurrentPrincipal() principal: Principal,
    @CurrentClient() client: ClientContext,
  ): Promise<CartQuote> {
    return this.applyCoupon.execute({ userId: principal.userId, ip: client.ip, code: body.code });
  }

  @Delete('cart/coupon')
  @RequirePermissions('cart:manage')
  @ApiOperation({ summary: 'Remove the coupon code from my cart (idempotent)' })
  @ApiOkResponse({ standardSchema: CartQuoteSchema })
  clearCoupon(@CurrentPrincipal() principal: Principal): Promise<CartQuote> {
    return this.removeCoupon.execute(principal.userId);
  }

  @Get('purchase-states')
  @RequirePermissions('enrollment:read:own')
  @ApiOperation({
    summary: 'Purchase state per course (enrolled, in cart, owner), at most 48 ids',
  })
  @ApiOkResponse({ standardSchema: PurchaseStatesResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  states(
    @Query({ schema: PurchaseStatesQuerySchema }) query: PurchaseStatesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PurchaseStatesResponse> {
    return this.purchaseStates.execute({ userId: principal.userId, courseIds: query.courseIds });
  }
}
