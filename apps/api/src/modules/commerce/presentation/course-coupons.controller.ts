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
  type CouponPage,
  CouponPageSchema,
  CouponSchema,
  type CouponsQuery,
  CouponsQuerySchema,
  type CourseCouponParams,
  CourseCouponParamsSchema,
  type CourseIdParams,
  CourseIdParamsSchema,
  type CreateCourseCouponRequest,
  CreateCourseCouponRequestSchema,
} from '@udemy/contracts';
import type { Response } from 'express';
import { CheckPolicy, CurrentPrincipal, type Principal } from '../../../shared/auth';
import { CreateCourseCouponCommand } from '../application/use-cases/create-course-coupon.command';
import { DeactivateCouponCommand } from '../application/use-cases/deactivate-coupon.command';
import { ListCouponsQuery } from '../application/use-cases/list-coupons.query';
import { courseCouponLocation, courseIdOf } from './commerce-http';

/**
 * `/api/v1/courses/:courseId/coupons` (design §8, instructor BFF): course coupons, nested
 * under the course policy; a coupon id of another course answers 404 (§9 IDOR).
 */
@ApiTags('commerce')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('courses')
export class CourseCouponsController {
  constructor(
    private readonly listCoupons: ListCouponsQuery,
    private readonly createCoupon: CreateCourseCouponCommand,
    private readonly deactivateCoupon: DeactivateCouponCommand,
  ) {}

  @Get(':courseId/coupons')
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({
    summary: 'Course coupons, newest first',
    description: 'Each with its terms, derived state and reserved/consumed counts.',
  })
  @ApiOkResponse({ standardSchema: CouponPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  list(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Query({ schema: CouponsQuerySchema }) query: CouponsQuery,
  ): Promise<CouponPage> {
    return this.listCoupons.execute({
      filter: { scope: 'COURSE', courseId: params.courseId },
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post(':courseId/coupons')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a course coupon (immutable afterwards, except deactivation)',
    description:
      'PERCENT 1–100 or AMOUNT up to the list price; a 1–31 day window starting at most 90 ' +
      'days ahead; at most 10 active coupons per course.',
  })
  @ApiCreatedResponse({
    standardSchema: CouponSchema,
    headers: { Location: { description: 'URL of the coupon', schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found' })
  @ApiConflictResponse({ description: 'coupon_code_taken' })
  @ApiUnprocessableEntityResponse({
    description: 'coupon_limit_exceeded / course_is_free / course_not_for_sale / validation_failed',
  })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async create(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: CreateCourseCouponRequestSchema }) body: CreateCourseCouponRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Coupon> {
    const coupon = await this.createCoupon.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      request: body,
    });
    res.location(courseCouponLocation(params.courseId, coupon.id));
    return coupon;
  }

  @Post(':courseId/coupons/:couponId/deactivate')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a course coupon (idempotent)' })
  @ApiOkResponse({ standardSchema: CouponSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found (also a coupon of another course)' })
  deactivate(
    @Param({ schema: CourseCouponParamsSchema }) params: CourseCouponParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Coupon> {
    return this.deactivateCoupon.execute({
      actorId: principal.userId,
      couponId: params.couponId,
      filter: { scope: 'COURSE', courseId: params.courseId },
    });
  }
}
