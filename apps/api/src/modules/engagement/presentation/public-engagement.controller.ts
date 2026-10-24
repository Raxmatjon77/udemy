import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type CourseIdParams,
  CourseIdParamsSchema,
  PUBLIC_ENGAGEMENT_CACHE_CONTROL,
  type PublicReviewPage,
  PublicReviewPageSchema,
  type PublicReviewsQuery,
  PublicReviewsQuerySchema,
  type RatingsQuery,
  RatingsQuerySchema,
  type RatingsResponse,
  RatingsResponseSchema,
} from '@udemy/contracts';
import { type ClientContext, CurrentClient, Public } from '../../../shared/auth';
import { GetRatingsQuery } from '../application/use-cases/get-ratings.query';
import { ListPublicReviewsQuery } from '../application/use-cases/list-public-reviews.query';

/**
 * `/api/v1/engagement/...` public reads (Phase 5 learning experience design §8 "Public"):
 * BFF client credentials, no session. Course cards fetch ratings in one batch per page; the
 * landing page lists the published reviews. Both are limited per end-user IP (240/min).
 */
@ApiTags('engagement-public')
@Public()
@Controller('engagement')
export class PublicEngagementController {
  constructor(
    private readonly ratings: GetRatingsQuery,
    private readonly publicReviews: ListPublicReviewsQuery,
  ) {}

  @Get('ratings')
  @Header('Cache-Control', PUBLIC_ENGAGEMENT_CACHE_CONTROL)
  @ApiOperation({
    summary: 'Course ratings (batch, at most 48 ids)',
    description:
      'One item per requested id; a course without reviews has `count: 0` and `average: null`. ' +
      'Eventually consistent (recomputed by the worker on every review event).',
  })
  @ApiOkResponse({ standardSchema: RatingsResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  list(
    @Query({ schema: RatingsQuerySchema }) query: RatingsQuery,
    @CurrentClient() client: ClientContext,
  ): Promise<RatingsResponse> {
    return this.ratings.execute({ courseIds: query.courseIds, ip: client.ip });
  }

  @Get('courses/:courseId/reviews')
  @Header('Cache-Control', PUBLIC_ENGAGEMENT_CACHE_CONTROL)
  @ApiOperation({
    summary: 'Published reviews of a course (newest first, keyset paginated)',
    description: 'Optionally one `rating`. Authors are public profiles (null when banned).',
  })
  @ApiOkResponse({ standardSchema: PublicReviewPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  reviews(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Query({ schema: PublicReviewsQuerySchema }) query: PublicReviewsQuery,
    @CurrentClient() client: ClientContext,
  ): Promise<PublicReviewPage> {
    return this.publicReviews.execute({
      courseId: params.courseId,
      rating: query.rating,
      cursor: query.cursor,
      limit: query.limit,
      ip: client.ip,
    });
  }
}
