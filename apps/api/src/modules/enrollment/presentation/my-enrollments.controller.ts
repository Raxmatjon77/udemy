import { Body, Controller, Get, HttpStatus, Post, Query, Res } from '@nestjs/common';
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
  type FreeEnrollmentRequest,
  FreeEnrollmentRequestSchema,
  type FreeEnrollmentResponse,
  FreeEnrollmentResponseSchema,
  type LearningCardPage,
  LearningCardPageSchema,
  type MyLearningQuery,
  MyLearningQuerySchema,
} from '@udemy/contracts';
import type { Response } from 'express';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { EnrollFreeCommand } from '../application/use-cases/enroll-free.command';
import { ListMyLearningQuery } from '../application/use-cases/list-my-learning.query';

/**
 * `/api/v1/me/...` enrollment routes of the student app (design §8): free enrollment (D14) and
 * "My learning". The STUDENT permissions exist only in the student app (D6).
 */
@ApiTags('enrollment')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('me')
export class MyEnrollmentsController {
  constructor(
    private readonly enrollFree: EnrollFreeCommand,
    private readonly myLearning: ListMyLearningQuery,
  ) {}

  @Post('free-enrollments')
  @RequirePermissions('enrollment:create')
  @ApiOperation({
    summary: 'Enroll in a free course',
    description:
      'Published courses priced at 0.00 only; no order, no email verification. Idempotent: ' +
      '201 for a new (or renewed) enrollment, 200 when already enrolled. 30 per hour.',
  })
  @ApiCreatedResponse({ standardSchema: FreeEnrollmentResponseSchema })
  @ApiOkResponse({ standardSchema: FreeEnrollmentResponseSchema, description: 'Already enrolled' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  @ApiConflictResponse({
    description: 'course_not_for_sale / course_not_free / cannot_purchase_own_course',
  })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async free(
    @Body({ schema: FreeEnrollmentRequestSchema }) body: FreeEnrollmentRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FreeEnrollmentResponse> {
    const { enrollment, created } = await this.enrollFree.execute({
      userId: principal.userId,
      courseId: body.courseId,
    });
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return enrollment;
  }

  @Get('enrollments')
  @RequirePermissions('enrollment:read:own')
  @ApiOperation({
    summary: 'My learning: my active enrollments (newest first, keyset paginated)',
    description: 'Cards show the live course title; `archived` courses stay watchable.',
  })
  @ApiOkResponse({ standardSchema: LearningCardPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  list(
    @Query({ schema: MyLearningQuerySchema }) query: MyLearningQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<LearningCardPage> {
    return this.myLearning.execute({
      userId: principal.userId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
