import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseInterceptors,
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
  type Announcement,
  type AnnouncementParams,
  AnnouncementParamsSchema,
  AnnouncementSchema,
  type AnnouncementsQuery,
  AnnouncementsQuerySchema,
  type CourseIdParams,
  CourseIdParamsSchema,
  type InstructorAnnouncementPage,
  InstructorAnnouncementPageSchema,
  type PostAnnouncementRequest,
  PostAnnouncementRequestSchema,
} from '@udemy/contracts';
import { CheckPolicy, CurrentPrincipal, type Principal } from '../../../shared/auth';
import { DeleteAnnouncementCommand } from '../application/use-cases/delete-announcement.command';
import { ListCourseAnnouncementsQuery } from '../application/use-cases/list-course-announcements.query';
import { PostAnnouncementCommand } from '../application/use-cases/post-announcement.command';
import { EngagementProblemsInterceptor } from './engagement-problems.interceptor';
import { courseIdOf } from './engagement-http';

/**
 * `/api/v1/courses/:courseId/announcements[/:announcementId]` (design §8 "Instructor", D18):
 * the owner's announcements with the posting quota (4 per course per 30 days, deleted posts
 * included), posting (422 `announcement_limit_exceeded` with `retryAt`) and the soft delete.
 * `course:engage:own` through catalog's course resolver (a foreign or unknown course is 404);
 * announcements are resolved within the course.
 */
@ApiTags('engagement-instructor')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@CheckPolicy({ resource: 'course', action: 'engage', id: courseIdOf })
@UseInterceptors(EngagementProblemsInterceptor)
@Controller('courses/:courseId/announcements')
export class CourseAnnouncementsController {
  constructor(
    private readonly list: ListCourseAnnouncementsQuery,
    private readonly post: PostAnnouncementCommand,
    private readonly remove: DeleteAnnouncementCommand,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Announcements of my course with the posting quota (newest first)' })
  @ApiOkResponse({ standardSchema: InstructorAnnouncementPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found (unknown or foreign course)' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  announcements(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Query({ schema: AnnouncementsQuerySchema }) query: AnnouncementsQuery,
  ): Promise<InstructorAnnouncementPage> {
    return this.list.execute({
      courseId: params.courseId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post()
  @ApiOperation({
    summary: 'Post an announcement to the enrolled students',
    description:
      'The course must be published or archived. At most 4 per course per 30 days (deleted ones ' +
      'count) and 20 per 24 h per instructor. `sendEmail` also e-mails it (per preferences).',
  })
  @ApiCreatedResponse({ standardSchema: AnnouncementSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found (not published)' })
  @ApiUnprocessableEntityResponse({
    description: 'announcement_limit_exceeded (retryAt) / markdown_not_allowed',
  })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  create(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: PostAnnouncementRequestSchema }) body: PostAnnouncementRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Announcement> {
    return this.post.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      title: body.title,
      bodyMd: body.bodyMd,
      sendEmail: body.sendEmail,
    });
  }

  @Delete(':announcementId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an announcement (does not refund the quota)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'announcement_not_found' })
  async delete(
    @Param({ schema: AnnouncementParamsSchema }) params: AnnouncementParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.remove.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      announcementId: params.announcementId,
    });
  }
}
