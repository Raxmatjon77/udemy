import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AdminCoursePage,
  AdminCoursePageSchema,
  type AdminCoursesQuery,
  AdminCoursesQuerySchema,
  type ApproveRevisionRequest,
  ApproveRevisionRequestSchema,
  type CourseDetail,
  CourseDetailSchema,
  type CourseIdParams,
  CourseIdParamsSchema,
  type CourseRevisionParams,
  CourseRevisionParamsSchema,
  type RejectRevisionRequest,
  RejectRevisionRequestSchema,
  type ReviewQueuePage,
  ReviewQueuePageSchema,
  type ReviewQueueQuery,
  ReviewQueueQuerySchema,
  type RevisionIdParams,
  RevisionIdParamsSchema,
  type RevisionReview,
  RevisionReviewSchema,
  type TakedownCourseRequest,
  TakedownCourseRequestSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { AdminSearchCoursesQuery } from '../application/use-cases/admin-search-courses.query';
import { ApproveRevisionCommand } from '../application/use-cases/approve-revision.command';
import { ArchiveCourseCommand } from '../application/use-cases/archive-course.command';
import { GetRevisionReviewQuery } from '../application/use-cases/get-revision-review.query';
import { ListReviewQueueQuery } from '../application/use-cases/list-review-queue.query';
import { RejectRevisionCommand } from '../application/use-cases/reject-revision.command';
import { RestoreCourseCommand } from '../application/use-cases/restore-course.command';

/**
 * `/api/v1/admin/...`: course moderation (design §5, §8; admin app only, D6). Approve and
 * reject always name the revision the moderator looked at (invariant 9). Revision playback
 * (`/admin/course-revisions/:revisionId/lectures/...`) is P2-T11's playback authorization.
 */
@ApiTags('catalog-admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('admin')
export class AdminCourseModerationController {
  constructor(
    private readonly reviewQueue: ListReviewQueueQuery,
    private readonly revisionReview: GetRevisionReviewQuery,
    private readonly approveRevision: ApproveRevisionCommand,
    private readonly rejectRevision: RejectRevisionCommand,
    private readonly searchCourses: AdminSearchCoursesQuery,
    private readonly archiveCourse: ArchiveCourseCommand,
    private readonly restoreCourse: RestoreCourseCommand,
  ) {}

  @Get('course-reviews')
  @RequirePermissions('course:moderate:any')
  @ApiOperation({ summary: 'Review queue: pending revisions, oldest first' })
  @ApiOkResponse({ standardSchema: ReviewQueuePageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  queue(
    @Query({ schema: ReviewQueueQuerySchema }) query: ReviewQueueQuery,
  ): Promise<ReviewQueuePage> {
    return this.reviewQueue.execute({ cursor: query.cursor, limit: query.limit });
  }

  @Get('course-revisions/:revisionId')
  @RequirePermissions('course:read:any')
  @ApiOperation({
    summary: 'A revision snapshot with its diff against the previously live revision',
  })
  @ApiOkResponse({ standardSchema: RevisionReviewSchema })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  revision(
    @Param({ schema: RevisionIdParamsSchema }) params: RevisionIdParams,
  ): Promise<RevisionReview> {
    return this.revisionReview.execute(params.revisionId);
  }

  @Post('courses/:courseId/revisions/:revisionId/approve')
  @RequirePermissions('course:moderate:any')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve the pending revision: it goes live' })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'self_decision_forbidden' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition / version_conflict' })
  approve(
    @Param({ schema: CourseRevisionParamsSchema }) params: CourseRevisionParams,
    @Body({ schema: ApproveRevisionRequestSchema }) body: ApproveRevisionRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseDetail> {
    return this.approveRevision.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      revisionId: params.revisionId,
      note: body.note,
      expectedVersion: body.expectedVersion,
    });
  }

  @Post('courses/:courseId/revisions/:revisionId/reject')
  @RequirePermissions('course:moderate:any')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject the pending revision (the reason is mailed to the author)' })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'self_decision_forbidden' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition / version_conflict' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (reason)' })
  reject(
    @Param({ schema: CourseRevisionParamsSchema }) params: CourseRevisionParams,
    @Body({ schema: RejectRevisionRequestSchema }) body: RejectRevisionRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseDetail> {
    return this.rejectRevision.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      revisionId: params.revisionId,
      reason: body.reason,
      expectedVersion: body.expectedVersion,
    });
  }

  @Get('courses')
  @RequirePermissions('course:read:any')
  @ApiOperation({
    summary: 'All courses, most recently changed first (with the owner ban flag)',
  })
  @ApiOkResponse({ standardSchema: AdminCoursePageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  courses(
    @Query({ schema: AdminCoursesQuerySchema }) query: AdminCoursesQuery,
  ): Promise<AdminCoursePage> {
    return this.searchCourses.execute({
      status: query.status,
      q: query.q,
      ownerId: query.ownerId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post('courses/:courseId/takedown')
  @RequirePermissions('course:moderate:any')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take a published course down (archive by a moderator)',
    description: 'The owner cannot restore it; the reason is mailed to them.',
  })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition (not published)' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (reason)' })
  takedown(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: TakedownCourseRequestSchema }) body: TakedownCourseRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseDetail> {
    return this.archiveCourse.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      reason: body.reason,
      byAdmin: true,
    });
  }

  @Post('courses/:courseId/restore')
  @RequirePermissions('course:moderate:any')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived course (any archive, including takedowns)' })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition (not archived)' })
  restore(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseDetail> {
    return this.restoreCourse.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      byAdmin: true,
    });
  }
}
