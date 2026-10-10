import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
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
  type CourseIdParams,
  CourseIdParamsSchema,
  type CoursePricing,
  CoursePricingSchema,
  type SetCoursePriceRequest,
  SetCoursePriceRequestSchema,
} from '@udemy/contracts';
import { CheckPolicy, CurrentPrincipal, type Principal } from '../../../shared/auth';
import { GetCoursePricingQuery } from '../application/use-cases/get-course-pricing.query';
import { SetCoursePriceCommand } from '../application/use-cases/set-course-price.command';
import { courseIdOf } from './commerce-http';

/**
 * `/api/v1/courses/:courseId/pricing` (design §8, instructor BFF): the course policy answers
 * 404 for another instructor's (or a deleted) course; admins may read any course's pricing.
 */
@ApiTags('commerce')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('courses')
export class CoursePricingController {
  constructor(
    private readonly getPricing: GetCoursePricingQuery,
    private readonly setPrice: SetCoursePriceCommand,
  ) {}

  @Get(':courseId/pricing')
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({
    summary: 'Course price and its change history',
    description: '`price: null` means the course is not for sale yet ("Set a price").',
  })
  @ApiOkResponse({ standardSchema: CoursePricingSchema })
  @ApiNotFoundResponse({ description: 'not_found' })
  get(@Param({ schema: CourseIdParamsSchema }) params: CourseIdParams): Promise<CoursePricing> {
    return this.getPricing.execute(params.courseId);
  }

  @Put(':courseId/pricing')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({
    summary: 'Set the course price (a price tier; "0.00" = free)',
    description:
      'Applies immediately to new purchases, also while the course is a draft or in review. ' +
      'At most 10 changes per course per 24 h; an unchanged price is a no-op.',
  })
  @ApiOkResponse({ standardSchema: CoursePricingSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found' })
  @ApiUnprocessableEntityResponse({ description: 'price_not_allowed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  set(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: SetCoursePriceRequestSchema }) body: SetCoursePriceRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CoursePricing> {
    return this.setPrice.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      amount: body.amount,
    });
  }
}
