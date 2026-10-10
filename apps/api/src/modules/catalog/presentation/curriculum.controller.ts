import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
  type Article,
  ArticleSchema,
  type AttachAssetRequest,
  AttachAssetRequestSchema,
  type CourseIdParams,
  CourseIdParamsSchema,
  type CreateLectureRequest,
  CreateLectureRequestSchema,
  type CreateSectionRequest,
  CreateSectionRequestSchema,
  type Curriculum,
  CurriculumSchema,
  type Lecture,
  type LectureParams,
  LectureParamsSchema,
  LectureSchema,
  type ReorderCurriculumRequest,
  ReorderCurriculumRequestSchema,
  type SaveArticleRequest,
  SaveArticleRequestSchema,
  type Section,
  type SectionParams,
  SectionParamsSchema,
  SectionSchema,
  type UpdateLectureRequest,
  UpdateLectureRequestSchema,
  type UpdateSectionRequest,
  UpdateSectionRequestSchema,
} from '@udemy/contracts';
import { CheckPolicy, CurrentPrincipal, type Principal } from '../../../shared/auth';
import { AddLectureCommand } from '../application/use-cases/add-lecture.command';
import { AddSectionCommand } from '../application/use-cases/add-section.command';
import { AttachLectureMediaCommand } from '../application/use-cases/attach-lecture-media.command';
import { DeleteLectureCommand } from '../application/use-cases/delete-lecture.command';
import { DeleteSectionCommand } from '../application/use-cases/delete-section.command';
import { DetachLectureMediaCommand } from '../application/use-cases/detach-lecture-media.command';
import { GetArticleQuery } from '../application/use-cases/get-article.query';
import { GetCurriculumQuery } from '../application/use-cases/get-curriculum.query';
import { ReorderCurriculumCommand } from '../application/use-cases/reorder-curriculum.command';
import { SaveArticleCommand } from '../application/use-cases/save-article.command';
import { UpdateLectureCommand } from '../application/use-cases/update-lecture.command';
import { UpdateSectionCommand } from '../application/use-cases/update-section.command';
import { courseIdOf, withMarkdownProblems } from './catalog-http';

const NESTED_404 =
  "not_found (another instructor's course) / course_not_found / section_not_found / lecture_not_found";

/**
 * `/api/v1/courses/:courseId/...`: curriculum of the working copy (design §8, D3). Sections and
 * lectures are reachable ONLY under their course: the policy checks the course, and every use
 * case loads the child scoped by it, so another course's section/lecture id is 404 (Q7).
 */
@ApiTags('catalog')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('courses/:courseId')
export class CurriculumController {
  constructor(
    private readonly getCurriculum: GetCurriculumQuery,
    private readonly reorderCurriculum: ReorderCurriculumCommand,
    private readonly addSection: AddSectionCommand,
    private readonly updateSection: UpdateSectionCommand,
    private readonly deleteSection: DeleteSectionCommand,
    private readonly addLecture: AddLectureCommand,
    private readonly updateLecture: UpdateLectureCommand,
    private readonly deleteLecture: DeleteLectureCommand,
    private readonly getArticle: GetArticleQuery,
    private readonly saveArticle: SaveArticleCommand,
    private readonly attachMedia: AttachLectureMediaCommand,
    private readonly detachMedia: DetachLectureMediaCommand,
  ) {}

  /* --------------------------------------------------------------------- curriculum */

  @Get('curriculum')
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({ summary: 'Sections and lectures with fresh media state' })
  @ApiOkResponse({ standardSchema: CurriculumSchema })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  curriculum(@Param({ schema: CourseIdParamsSchema }) params: CourseIdParams): Promise<Curriculum> {
    return this.getCurriculum.execute(params.courseId);
  }

  @Put('curriculum/order')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({
    summary: 'Reorder the whole curriculum',
    description:
      'Every section and lecture exactly once (lectures may change section); otherwise 409 order_mismatch.',
  })
  @ApiOkResponse({ standardSchema: CurriculumSchema })
  @ApiBadRequestResponse({ description: 'validation_failed (duplicates, sizes)' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'order_mismatch / course_in_review / course_not_editable' })
  reorder(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: ReorderCurriculumRequestSchema }) body: ReorderCurriculumRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Curriculum> {
    return this.reorderCurriculum.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      sections: body.sections,
    });
  }

  /* ----------------------------------------------------------------------- sections */

  @Post('sections')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append a section' })
  @ApiCreatedResponse({ standardSchema: SectionSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found' })
  @ApiConflictResponse({ description: 'course_in_review / course_not_editable' })
  @ApiUnprocessableEntityResponse({ description: 'curriculum_limit_exceeded' })
  createSection(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: CreateSectionRequestSchema }) body: CreateSectionRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Section> {
    return this.addSection.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      title: body.title,
      objective: body.objective,
    });
  }

  @Patch('sections/:sectionId')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({ summary: 'Edit a section' })
  @ApiOkResponse({ standardSchema: SectionSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: NESTED_404 })
  @ApiConflictResponse({ description: 'course_in_review / course_not_editable' })
  patchSection(
    @Param({ schema: SectionParamsSchema }) params: SectionParams,
    @Body({ schema: UpdateSectionRequestSchema }) body: UpdateSectionRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Section> {
    return this.updateSection.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      sectionId: params.sectionId,
      patch: { title: body.title, objective: body.objective },
    });
  }

  @Delete('sections/:sectionId')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a section and its lectures (media usages are released)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: NESTED_404 })
  @ApiConflictResponse({ description: 'course_in_review / course_not_editable' })
  async removeSection(
    @Param({ schema: SectionParamsSchema }) params: SectionParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.deleteSection.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      sectionId: params.sectionId,
    });
  }

  @Post('sections/:sectionId/lectures')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append a lecture to a section (the type is immutable)' })
  @ApiCreatedResponse({ standardSchema: LectureSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: NESTED_404 })
  @ApiConflictResponse({ description: 'course_in_review / course_not_editable' })
  @ApiUnprocessableEntityResponse({ description: 'curriculum_limit_exceeded' })
  createLecture(
    @Param({ schema: SectionParamsSchema }) params: SectionParams,
    @Body({ schema: CreateLectureRequestSchema }) body: CreateLectureRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Lecture> {
    return this.addLecture.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      sectionId: params.sectionId,
      type: body.type,
      title: body.title,
    });
  }

  /* ----------------------------------------------------------------------- lectures */

  @Patch('lectures/:lectureId')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({ summary: 'Edit a lecture (title, description, free preview)' })
  @ApiOkResponse({ standardSchema: LectureSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: NESTED_404 })
  @ApiConflictResponse({ description: 'course_in_review / course_not_editable' })
  @ApiUnprocessableEntityResponse({
    description: 'preview_not_allowed / markdown_not_allowed (+ issues[])',
  })
  patchLecture(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @Body({ schema: UpdateLectureRequestSchema }) body: UpdateLectureRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Lecture> {
    return withMarkdownProblems(() =>
      this.updateLecture.execute({
        actorId: principal.userId,
        courseId: params.courseId,
        lectureId: params.lectureId,
        patch: { title: body.title, descriptionMd: body.descriptionMd, isPreview: body.isPreview },
      }),
    );
  }

  @Delete('lectures/:lectureId')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a lecture (its media usage is released)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: NESTED_404 })
  @ApiConflictResponse({ description: 'course_in_review / course_not_editable' })
  async removeLecture(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.deleteLecture.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
    });
  }

  @Get('lectures/:lectureId/article')
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({ summary: 'Article markdown of an ARTICLE lecture' })
  @ApiOkResponse({ standardSchema: ArticleSchema })
  @ApiNotFoundResponse({ description: NESTED_404 })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch' })
  article(@Param({ schema: LectureParamsSchema }) params: LectureParams): Promise<Article> {
    return this.getArticle.execute({ courseId: params.courseId, lectureId: params.lectureId });
  }

  @Put('lectures/:lectureId/article')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({ summary: 'Save the article markdown (stored verbatim)' })
  @ApiOkResponse({ standardSchema: ArticleSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: NESTED_404 })
  @ApiConflictResponse({ description: 'course_in_review / course_not_editable' })
  @ApiUnprocessableEntityResponse({
    description: 'markdown_not_allowed (+ issues[]) / lecture_type_mismatch',
  })
  putArticle(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @Body({ schema: SaveArticleRequestSchema }) body: SaveArticleRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Article> {
    return withMarkdownProblems(() =>
      this.saveArticle.execute({
        actorId: principal.userId,
        courseId: params.courseId,
        lectureId: params.lectureId,
        bodyMd: body.bodyMd,
      }),
    );
  }

  @Put('lectures/:lectureId/media')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({
    summary: 'Attach (or swap) the lecture video/resource',
    description: 'A LECTURE_VIDEO asset for VIDEO, a LECTURE_RESOURCE asset for RESOURCE lectures.',
  })
  @ApiOkResponse({ standardSchema: LectureSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({
    description: `${NESTED_404} / media_asset_not_found (also others' assets)`,
  })
  @ApiConflictResponse({
    description: 'media_asset_unusable / course_in_review / course_not_editable',
  })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch / media_purpose_mismatch' })
  putMedia(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @Body({ schema: AttachAssetRequestSchema }) body: AttachAssetRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Lecture> {
    return this.attachMedia.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      assetId: body.assetId,
    });
  }

  @Delete('lectures/:lectureId/media')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({ summary: 'Detach the lecture media (the usage is released)' })
  @ApiOkResponse({ standardSchema: LectureSchema })
  @ApiNotFoundResponse({ description: NESTED_404 })
  @ApiConflictResponse({ description: 'course_in_review / course_not_editable' })
  removeMedia(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Lecture> {
    return this.detachMedia.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
    });
  }
}
