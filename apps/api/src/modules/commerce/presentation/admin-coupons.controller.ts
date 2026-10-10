import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
  type Coupon,
  type CouponIdParams,
  CouponIdParamsSchema,
  type CouponPage,
  CouponPageSchema,
  CouponSchema,
  type CouponsQuery,
  CouponsQuerySchema,
  type CreatePlatformCouponRequest,
  CreatePlatformCouponRequestSchema,
} from '@udemy/contracts';
import type { Response } from 'express';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { CreatePlatformCouponCommand } from '../application/use-cases/create-platform-coupon.command';
import { DeactivateCouponCommand } from '../application/use-cases/deactivate-coupon.command';
import { ListCouponsQuery } from '../application/use-cases/list-coupons.query';
import { platformCouponLocation } from './commerce-http';

/** `/api/v1/admin/coupons` (design §8, admin BFF): platform coupons (all courses, PERCENT). */
@ApiTags('commerce-admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('platform_coupon:manage')
@Controller('admin/coupons')
export class AdminCouponsController {
  constructor(
    private readonly listCoupons: ListCouponsQuery,
    private readonly createCoupon: CreatePlatformCouponCommand,
    private readonly deactivateCoupon: DeactivateCouponCommand,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Platform coupons, newest first' })
  @ApiOkResponse({ standardSchema: CouponPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  list(@Query({ schema: CouponsQuerySchema }) query: CouponsQuery): Promise<CouponPage> {
    return this.listCoupons.execute({
      filter: { scope: 'PLATFORM' },
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a platform coupon (PERCENT, at most 90 days)',
    description:
      'Applies to every course; where a course coupon has the same code, the better one wins ' +
      'per line (a tie goes to the course coupon).',
  })
  @ApiCreatedResponse({
    standardSchema: CouponSchema,
    headers: { Location: { description: 'URL of the coupon', schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiConflictResponse({ description: 'coupon_code_taken' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async create(
    @Body({ schema: CreatePlatformCouponRequestSchema }) body: CreatePlatformCouponRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Coupon> {
    const coupon = await this.createCoupon.execute({ actorId: principal.userId, request: body });
    res.location(platformCouponLocation(coupon.id));
    return coupon;
  }

  @Post(':couponId/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a platform coupon (idempotent)' })
  @ApiOkResponse({ standardSchema: CouponSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found (also a course coupon id)' })
  deactivate(
    @Param({ schema: CouponIdParamsSchema }) params: CouponIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Coupon> {
    return this.deactivateCoupon.execute({
      actorId: principal.userId,
      couponId: params.couponId,
      filter: { scope: 'PLATFORM' },
    });
  }
}
