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
  Query,
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
  type CreateNoteRequest,
  CreateNoteRequestSchema,
  type Note,
  type NoteIdParams,
  NoteIdParamsSchema,
  type NotePage,
  NotePageSchema,
  NoteSchema,
  type NotesQuery,
  NotesQuerySchema,
  type UpdateNoteRequest,
  UpdateNoteRequestSchema,
} from '@udemy/contracts';
import {
  CheckPolicy,
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '../../../shared/auth';
import {
  CreateNoteCommand,
  DeleteNoteCommand,
  ListNotesQuery,
  UpdateNoteCommand,
} from '../application/use-cases/notes.use-cases';
import { noteIdOf } from './learning-http';

/**
 * Private lecture notes of the student app (design §8 "Student", P5-T11). The course routes need
 * an ACTIVE enrollment; editing and deleting one's own notes works after a revoke too (D9).
 * IDOR: `note` ids resolve to their owner (`@CheckPolicy`, foreign = 404) and every query is
 * scoped to the principal.
 */
@ApiTags('learning')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiBadRequestResponse({ description: 'validation_failed' })
@Controller('me')
export class LearningNotesController {
  constructor(
    private readonly listNotes: ListNotesQuery,
    private readonly createNote: CreateNoteCommand,
    private readonly updateNote: UpdateNoteCommand,
    private readonly deleteNote: DeleteNoteCommand,
  ) {}

  @Get('courses/:courseId/notes')
  @RequirePermissions('note:manage:own')
  @ApiOperation({
    summary: 'My notes of a course (newest first, keyset paginated)',
    description: 'Optionally one lecture (`lectureId`). Requires an ACTIVE enrollment.',
  })
  @ApiOkResponse({ standardSchema: NotePageSchema })
  @ApiForbiddenResponse({ description: 'enrollment_required' })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  list(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Query({ schema: NotesQuerySchema }) query: NotesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotePage> {
    return this.listNotes.execute({
      userId: principal.userId,
      courseId: params.courseId,
      lectureId: query.lectureId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post('courses/:courseId/notes')
  @RequirePermissions('note:manage:own')
  @ApiOperation({
    summary: 'Add a note to a lecture',
    description:
      'Markdown without HTML or images; a timestamp only on a video, within its duration. ' +
      'At most 500 notes per course; 120 note writes per hour.',
  })
  @ApiCreatedResponse({ standardSchema: NoteSchema })
  @ApiForbiddenResponse({ description: 'enrollment_required' })
  @ApiNotFoundResponse({ description: 'course_not_found / lecture_not_found' })
  @ApiUnprocessableEntityResponse({
    description: 'markdown_not_allowed / note_limit_exceeded / validation_failed',
  })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  create(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: CreateNoteRequestSchema }) body: CreateNoteRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Note> {
    return this.createNote.execute({
      userId: principal.userId,
      courseId: params.courseId,
      lectureId: body.lectureId,
      positionSeconds: body.positionSeconds,
      bodyMd: body.bodyMd,
    });
  }

  @Patch('notes/:noteId')
  @CheckPolicy({ resource: 'note', action: 'manage', id: noteIdOf })
  @ApiOperation({
    summary: 'Edit my note',
    description: '`positionSeconds: null` clears the timestamp. Allowed after a refund (D9).',
  })
  @ApiOkResponse({ standardSchema: NoteSchema })
  @ApiNotFoundResponse({ description: 'not_found / note_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'markdown_not_allowed / validation_failed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  update(
    @Param({ schema: NoteIdParamsSchema }) params: NoteIdParams,
    @Body({ schema: UpdateNoteRequestSchema }) body: UpdateNoteRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Note> {
    return this.updateNote.execute({
      userId: principal.userId,
      noteId: params.noteId,
      bodyMd: body.bodyMd,
      positionSeconds: body.positionSeconds,
    });
  }

  @Delete('notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CheckPolicy({ resource: 'note', action: 'manage', id: noteIdOf })
  @ApiOperation({ summary: 'Delete my note', description: 'Allowed after a refund (D9).' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'not_found / note_not_found' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async remove(
    @Param({ schema: NoteIdParamsSchema }) params: NoteIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.deleteNote.execute({ userId: principal.userId, noteId: params.noteId });
  }
}
