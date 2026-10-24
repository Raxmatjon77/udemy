import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AnnouncementPage,
  AnnouncementPageSchema,
  type AnnouncementsQuery,
  AnnouncementsQuerySchema,
  type CourseIdParams,
  CourseIdParamsSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { ListAnnouncementsQuery } from '../application/use-cases/list-announcements.query';

/**
 * `GET /api/v1/me/courses/:courseId/announcements` (design §8 "Student"): the course's
 * announcements for an ACTIVE learner, or the owner previewing in the student app
 * (`learning:participate`, student app only).
 */
@ApiTags('engagement')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('learning:participate')
@Controller('me/courses/:courseId/announcements')
export class MyAnnouncementsController {
  constructor(private readonly list: ListAnnouncementsQuery) {}

  @Get()
  @ApiOperation({ summary: 'Announcements of a course I learn (newest first, keyset paginated)' })
  @ApiOkResponse({ standardSchema: AnnouncementPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'enrollment_required' })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  announcements(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Query({ schema: AnnouncementsQuerySchema }) query: AnnouncementsQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AnnouncementPage> {
    return this.list.execute({
      viewer: { userId: principal.userId, app: principal.app },
      courseId: params.courseId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
