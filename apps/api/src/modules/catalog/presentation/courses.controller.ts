import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AttachAssetRequest,
  AttachAssetRequestSchema,
  type CourseDetail,
  CourseDetailSchema,
  type CourseIdParams,
  CourseIdParamsSchema,
  type UpdateCourseRequest,
  UpdateCourseRequestSchema,
} from '@udemy/contracts';
import { CheckPolicy, CurrentPrincipal, type Principal } from '../../../shared/auth';
import { ClearCourseThumbnailCommand } from '../application/use-cases/clear-course-thumbnail.command';
import { DeleteCourseCommand } from '../application/use-cases/delete-course.command';
import { GetCourseQuery } from '../application/use-cases/get-course.query';
import { SetCourseThumbnailCommand } from '../application/use-cases/set-course-thumbnail.command';
import { UpdateCourseCommand } from '../application/use-cases/update-course.command';
import { courseIdOf, withMarkdownProblems } from './catalog-http';

/**
 * `/api/v1/courses/:courseId`: the course working copy (design §8). `@CheckPolicy` on the
 * course answers 404 for another instructor's course (never 403); admins read any course.
 */
@ApiTags('catalog')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('courses')
export class CoursesController {
  constructor(
    private readonly getCourse: GetCourseQuery,
    private readonly updateCourse: UpdateCourseCommand,
    private readonly deleteCourse: DeleteCourseCommand,
    private readonly setThumbnail: SetCourseThumbnailCommand,
    private readonly clearThumbnail: ClearCourseThumbnailCommand,
  ) {}

  @Get(':courseId')
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({
    summary: 'Course detail (working copy)',
    description: 'Includes the readiness checklist, lifecycle pointers and the latest decision.',
  })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  get(@Param({ schema: CourseIdParamsSchema }) params: CourseIdParams): Promise<CourseDetail> {
    return this.getCourse.execute(params.courseId);
  }

  @Patch(':courseId')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({
    summary: 'Edit the course details, slug, outcomes and requirements',
    description: 'Send `expectedVersion` for optimistic locking.',
  })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found / category_not_found' })
  @ApiConflictResponse({
    description:
      'version_conflict / course_in_review / course_not_editable / slug_frozen / slug_taken',
  })
  @ApiUnprocessableEntityResponse({
    description: 'markdown_not_allowed (+ issues[]) / category_inactive / category_not_leaf',
  })
  update(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: UpdateCourseRequestSchema }) body: UpdateCourseRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseDetail> {
    const { expectedVersion, ...changes } = body;
    return withMarkdownProblems(() =>
      this.updateCourse.execute({
        actorId: principal.userId,
        courseId: params.courseId,
        changes,
        expectedVersion,
      }),
    );
  }

  @Delete(':courseId')
  @CheckPolicy({ resource: 'course', action: 'delete', id: courseIdOf })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a never-published course',
    description: 'Published courses cannot be deleted; archive them instead.',
  })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'course_published_cannot_delete / course_in_review' })
  async delete(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.deleteCourse.execute({ actorId: principal.userId, courseId: params.courseId });
  }

  @Put(':courseId/thumbnail')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({ summary: 'Set the thumbnail (a COURSE_THUMBNAIL asset of the course owner)' })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({
    description: "course_not_found / media_asset_not_found (also others' assets)",
  })
  @ApiConflictResponse({
    description: 'course_in_review / course_not_editable / media_asset_unusable',
  })
  @ApiUnprocessableEntityResponse({ description: 'media_purpose_mismatch' })
  setThumbnailAsset(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: AttachAssetRequestSchema }) body: AttachAssetRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseDetail> {
    return this.setThumbnail.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      assetId: body.assetId,
    });
  }

  @Delete(':courseId/thumbnail')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({ summary: 'Remove the thumbnail' })
  @ApiOkResponse({ standardSchema: CourseDetailSchema })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'course_in_review / course_not_editable' })
  clearThumbnailAsset(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CourseDetail> {
    return this.clearThumbnail.execute({ actorId: principal.userId, courseId: params.courseId });
  }
}
