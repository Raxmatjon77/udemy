import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
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
  type MyCourseReview,
  MyCourseReviewSchema,
  type MyReview,
  MyReviewSchema,
  type UpsertReviewRequest,
  UpsertReviewRequestSchema,
} from '@udemy/contracts';
import type { Response } from 'express';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { DeleteMyReviewCommand } from '../application/use-cases/delete-my-review.command';
import { GetMyCourseReviewQuery } from '../application/use-cases/get-my-course-review.query';
import { UpsertMyReviewCommand } from '../application/use-cases/upsert-my-review.command';

/**
 * `/api/v1/me/courses/:courseId/review` (design §8 "Student"): the caller's own review of a
 * course. `review:write:own` exists in the student app only (D6). Ownership is by construction:
 * every query is scoped to the principal's user id.
 */
@ApiTags('engagement')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('review:write:own')
@Controller('me/courses/:courseId/review')
export class MyReviewsController {
  constructor(
    private readonly getMine: GetMyCourseReviewQuery,
    private readonly upsertMine: UpsertMyReviewCommand,
    private readonly deleteMine: DeleteMyReviewCommand,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My review of a course and whether I may write one',
    description:
      '`review` is null when there is none; `blockReason` explains why `canReview` is false.',
  })
  @ApiOkResponse({ standardSchema: MyCourseReviewSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  get(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MyCourseReview> {
    return this.getMine.execute({ userId: principal.userId, courseId: params.courseId });
  }

  @Put()
  @ApiOperation({
    summary: 'Write or edit my review (rating 1-5, optional plain-text body)',
    description:
      'Needs an ACTIVE enrollment and at least one completed lecture; owners cannot review. ' +
      '201 for a new review, 200 for an edit or an unchanged repeat. 20 per 24 h.',
  })
  @ApiCreatedResponse({ standardSchema: MyReviewSchema })
  @ApiOkResponse({ standardSchema: MyReviewSchema, description: 'Edited or unchanged' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'enrollment_required / cannot_review_own_course' })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'review_not_eligible' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async put(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: UpsertReviewRequestSchema }) body: UpsertReviewRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MyReview> {
    const { review, created } = await this.upsertMine.execute({
      userId: principal.userId,
      courseId: params.courseId,
      rating: body.rating,
      body: body.body ?? null,
    });
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return review;
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete my review',
    description: 'Soft delete; a new review may follow.',
  })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'review_not_found' })
  async delete(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.deleteMine.execute({ userId: principal.userId, courseId: params.courseId });
  }
}
