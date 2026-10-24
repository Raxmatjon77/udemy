import { Controller, Get, Query } from '@nestjs/common';
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
  type InstructorQaPage,
  InstructorQaPageSchema,
  type InstructorQaQuery,
  InstructorQaQuerySchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { InstructorQaInboxQuery } from '../application/use-cases/instructor-qa-inbox.query';

/**
 * `GET /api/v1/instructor/qa` (design §8 "Instructor"): the Q&A inbox across the caller's own
 * courses (`course:engage:own`, instructor app). Ownership is by construction: the course ids
 * come from catalog for the principal, and a `courseId` filter on a foreign course is 404.
 */
@ApiTags('engagement-instructor')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('course:engage:own')
@Controller('instructor/qa')
export class InstructorQaController {
  constructor(private readonly inbox: InstructorQaInboxQuery) {}

  @Get()
  @ApiOperation({
    summary: 'Q&A inbox over my courses (newest first, keyset paginated)',
    description:
      '`status`: unanswered (default), unresolved or all; `courseId` narrows to one course.',
  })
  @ApiOkResponse({ standardSchema: InstructorQaPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'course_not_found (unknown or foreign courseId)' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  list(
    @Query({ schema: InstructorQaQuerySchema }) query: InstructorQaQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InstructorQaPage> {
    return this.inbox.execute({
      ownerId: principal.userId,
      courseId: query.courseId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
