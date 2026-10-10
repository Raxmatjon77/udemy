import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
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
  type ArchiveCourseRequest,
  ArchiveCourseRequestSchema,
  type CourseDetail,
  CourseDetailSchema,
  type CourseHistoryResponse,
  CourseHistoryResponseSchema,
  type CourseIdParams,
  CourseIdParamsSchema,
  type SubmitCourseRequest,
  SubmitCourseRequestSchema,
  type SubmitCourseResponse,
  SubmitCourseResponseSchema,
} from '@udemy/contracts';
import { CheckPolicy, CurrentPrincipal, type Principal } from '../../../shared/auth';
import { ArchiveCourseCommand } from '../application/use-cases/archive-course.command';
import { GetCourseHistoryQuery } from '../application/use-cases/get-course-history.query';
import { RestoreCourseCommand } from '../application/use-cases/restore-course.command';
import { SubmitCourseCommand } from '../application/use-cases/submit-course.command';
import { WithdrawSubmissionCommand } from '../application/use-cases/withdraw-submission.command';
import { courseIdOf, withSubmitProblems } from './catalog-http';

/**
 * `/api/v1/courses/:courseId/...`: the owner's lifecycle actions and the course history
 * (design §5, §8). The course policy answers 404 for another instructor's course.
 */
@ApiTags('catalog')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('courses/:courseId')
export class CourseLifecycleController {
  constructor(
    private readonly submitCourse: SubmitCourseCommand,
    private readonly withdrawSubmission: WithdrawSubmissionCommand,
    private readonly archiveCourse: ArchiveCourseCommand,
    private readonly restoreCourse: RestoreCourseCommand,
    private readonly courseHistory: GetCourseHistoryQuery,
  ) {}

  @Post('submit')
  @CheckPolicy({ resource: 'course', action: 'submit', id: courseIdOf })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit the working copy for review',
    description:
      'Snapshots the course into an immutable revision; the builder is read-only until the ' +
      'review is decided or the submission is withdrawn.',
  })
  @ApiOkResponse({ standardSchema: SubmitCourseResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({
    description: 'review_already_pending / nothing_to_review / course_not_editable',
  })
  @ApiUnprocessableEntityResponse({ description: 'course_not_ready (+ issues[])' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  submit(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: SubmitCourseRequestSchema }) body: SubmitCourseRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SubmitCourseResponse> {
    return withSubmitProblems(() =>
      this.submitCourse.execute({
        actorId: principal.userId,
        courseId: params.courseId,
        note: body.note,
      }),
    );
  }

  @Post('withdraw')
  @CheckPolicy({ resource: 'course', action: 'submit', id: courseIdOf })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw the pending submission to edit the course again' })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition (nothing pending)' })
  withdraw(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseDetail> {
    return this.withdrawSubmission.execute({
      actorId: principal.userId,
      courseId: params.courseId,
    });
  }

  @Post('archive')
  @CheckPolicy({ resource: 'course', action: 'archive', id: courseIdOf })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a published course (hidden from the catalog)',
    description: 'A pending update is withdrawn automatically. The owner can restore it later.',
  })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition (not published)' })
  archive(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: ArchiveCourseRequestSchema }) body: ArchiveCourseRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseDetail> {
    return this.archiveCourse.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      reason: body.reason,
      byAdmin: false,
    });
  }

  @Post('restore')
  @CheckPolicy({ resource: 'course', action: 'archive', id: courseIdOf })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a course you archived yourself' })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition (not archived)' })
  @ApiForbiddenResponse({ description: 'restore_forbidden (taken down by a moderator)' })
  restore(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseDetail> {
    return this.restoreCourse.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      byAdmin: false,
    });
  }

  @Get('history')
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({
    summary: 'Lifecycle history, oldest first',
    description: 'Instructors see moderators as "Moderator"; admins see every actor by name.',
  })
  @ApiOkResponse({ standardSchema: CourseHistoryResponseSchema })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  history(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseHistoryResponse> {
    return this.courseHistory.execute({
      courseId: params.courseId,
      viewerIsModerator: principal.permissions.has('course:read:any'),
    });
  }
}
