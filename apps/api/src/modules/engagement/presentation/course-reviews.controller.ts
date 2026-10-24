import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
  type CourseReviewParams,
  CourseReviewParamsSchema,
  type InstructorReviewPage,
  InstructorReviewPageSchema,
  type InstructorReviewsQuery,
  InstructorReviewsQuerySchema,
  type ReviewReply,
  ReviewReplySchema,
  type UpsertReviewReplyRequest,
  UpsertReviewReplyRequestSchema,
} from '@udemy/contracts';
import { CheckPolicy, CurrentPrincipal, type Principal } from '../../../shared/auth';
import { DeleteReviewReplyCommand } from '../application/use-cases/delete-review-reply.command';
import { ListCourseReviewsQuery } from '../application/use-cases/list-course-reviews.query';
import { UpsertReviewReplyCommand } from '../application/use-cases/upsert-review-reply.command';
import { courseIdOf } from './engagement-http';

/**
 * `/api/v1/courses/:courseId/reviews[/:reviewId/reply]` (design §8 "Instructor"): the owner's
 * view of the course reviews and the one reply per review. `course:engage:own` through catalog's
 * course resolver (a foreign or unknown course is 404); reviews are resolved within the course.
 */
@ApiTags('engagement-instructor')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@CheckPolicy({ resource: 'course', action: 'engage', id: courseIdOf })
@Controller('courses/:courseId/reviews')
export class CourseReviewsController {
  constructor(
    private readonly list: ListCourseReviewsQuery,
    private readonly upsertReply: UpsertReviewReplyCommand,
    private readonly deleteReply: DeleteReviewReplyCommand,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Reviews of my course (newest first, keyset paginated)',
    description: 'Every non-deleted review with its state (PUBLISHED / HIDDEN / SUSPENDED).',
  })
  @ApiOkResponse({ standardSchema: InstructorReviewPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found (unknown or foreign course)' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  reviews(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Query({ schema: InstructorReviewsQuerySchema }) query: InstructorReviewsQuery,
  ): Promise<InstructorReviewPage> {
    return this.list.execute({
      courseId: params.courseId,
      rating: query.rating,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Put(':reviewId/reply')
  @ApiOperation({
    summary: 'Reply to a review (or edit my reply)',
    description: 'Plain text; the review must be published or hidden. 100 per 24 h.',
  })
  @ApiOkResponse({ standardSchema: ReviewReplySchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'review_not_found' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  reply(
    @Param({ schema: CourseReviewParamsSchema }) params: CourseReviewParams,
    @Body({ schema: UpsertReviewReplyRequestSchema }) body: UpsertReviewReplyRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ReviewReply> {
    return this.upsertReply.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      reviewId: params.reviewId,
      body: body.body,
    });
  }

  @Delete(':reviewId/reply')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete my reply to a review' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'review_not_found / reply_not_found' })
  async removeReply(
    @Param({ schema: CourseReviewParamsSchema }) params: CourseReviewParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.deleteReply.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      reviewId: params.reviewId,
    });
  }
}
