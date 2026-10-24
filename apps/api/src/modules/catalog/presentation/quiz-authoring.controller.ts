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
  type CreateQuizQuestionRequest,
  CreateQuizQuestionRequestSchema,
  type LectureParams,
  LectureParamsSchema,
  type PutQuizQuestionOptionsRequest,
  PutQuizQuestionOptionsRequestSchema,
  type QuizAuthoring,
  QuizAuthoringSchema,
  type QuizQuestionAuthoring,
  QuizQuestionAuthoringSchema,
  type QuizQuestionParams,
  QuizQuestionParamsSchema,
  type ReorderQuizQuestionsRequest,
  ReorderQuizQuestionsRequestSchema,
  type UpdateQuizQuestionRequest,
  UpdateQuizQuestionRequestSchema,
  type UpdateQuizSettingsRequest,
  UpdateQuizSettingsRequestSchema,
} from '@udemy/contracts';
import { CheckPolicy, CurrentPrincipal, type Principal } from '../../../shared/auth';
import { AddQuizQuestionCommand } from '../application/use-cases/add-quiz-question.command';
import { DeleteQuizQuestionCommand } from '../application/use-cases/delete-quiz-question.command';
import { GetQuizQuery } from '../application/use-cases/get-quiz.query';
import { PutQuizQuestionOptionsCommand } from '../application/use-cases/put-quiz-question-options.command';
import { ReorderQuizQuestionsCommand } from '../application/use-cases/reorder-quiz-questions.command';
import { UpdateQuizQuestionCommand } from '../application/use-cases/update-quiz-question.command';
import { UpdateQuizSettingsCommand } from '../application/use-cases/update-quiz-settings.command';
import { courseIdOf, withMarkdownProblems } from './catalog-http';

const QUIZ_404 = "not_found (another instructor's course) / course_not_found / lecture_not_found";
const QUESTION_404 = `${QUIZ_404} / quiz_question_not_found`;
const LOCKED_409 = 'course_in_review / course_not_editable';

/**
 * `/api/v1/courses/:courseId/lectures/:lectureId/quiz...`: the working copy of a QUIZ lecture
 * (Phase 5 learning experience design D6, §5 catalog, §8 instructor). Like every nested route,
 * the policy checks the COURSE (`course:read` for GET, `course:update` for writes: the owner,
 * plus admins for reads) and the use cases resolve the lecture and question scoped by it, so
 * ids of another course or quiz are 404. These responses carry the ANSWER KEY (`isCorrect`,
 * `explanationMd`): no learner route ever returns these schemas.
 */
@ApiTags('catalog')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('courses/:courseId/lectures/:lectureId/quiz')
export class QuizAuthoringController {
  constructor(
    private readonly getQuiz: GetQuizQuery,
    private readonly updateSettings: UpdateQuizSettingsCommand,
    private readonly addQuestion: AddQuizQuestionCommand,
    private readonly updateQuestion: UpdateQuizQuestionCommand,
    private readonly deleteQuestion: DeleteQuizQuestionCommand,
    private readonly putOptions: PutQuizQuestionOptionsCommand,
    private readonly reorderQuestions: ReorderQuizQuestionsCommand,
  ) {}

  @Get()
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({
    summary: 'The working-copy quiz of a QUIZ lecture, with its answer key (owner or admin)',
  })
  @ApiOkResponse({ standardSchema: QuizAuthoringSchema })
  @ApiNotFoundResponse({ description: QUIZ_404 })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not a QUIZ lecture)' })
  quiz(@Param({ schema: LectureParamsSchema }) params: LectureParams): Promise<QuizAuthoring> {
    return this.getQuiz.execute({ courseId: params.courseId, lectureId: params.lectureId });
  }

  @Put()
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({ summary: 'Quiz settings (pass mark 1–100)' })
  @ApiOkResponse({ standardSchema: QuizAuthoringSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: QUIZ_404 })
  @ApiConflictResponse({ description: LOCKED_409 })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch / validation_failed' })
  putSettings(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @Body({ schema: UpdateQuizSettingsRequestSchema }) body: UpdateQuizSettingsRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuizAuthoring> {
    return this.updateSettings.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      passPct: body.passPct,
    });
  }

  @Post('questions')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append a question (options are set with PUT …/options)' })
  @ApiCreatedResponse({ standardSchema: QuizQuestionAuthoringSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: QUIZ_404 })
  @ApiConflictResponse({ description: LOCKED_409 })
  @ApiUnprocessableEntityResponse({
    description:
      'lecture_type_mismatch / quiz_limit_exceeded (50) / markdown_not_allowed (+ issues[])',
  })
  createQuestion(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @Body({ schema: CreateQuizQuestionRequestSchema }) body: CreateQuizQuestionRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuizQuestionAuthoring> {
    return withMarkdownProblems(() =>
      this.addQuestion.execute({
        actorId: principal.userId,
        courseId: params.courseId,
        lectureId: params.lectureId,
        kind: body.kind,
        promptMd: body.promptMd,
        explanationMd: body.explanationMd,
      }),
    );
  }

  @Patch('questions/:questionId')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({ summary: 'Edit a question (kind, prompt, explanation)' })
  @ApiOkResponse({ standardSchema: QuizQuestionAuthoringSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: QUESTION_404 })
  @ApiConflictResponse({ description: LOCKED_409 })
  @ApiUnprocessableEntityResponse({
    description: 'lecture_type_mismatch / markdown_not_allowed (+ issues[])',
  })
  patchQuestion(
    @Param({ schema: QuizQuestionParamsSchema }) params: QuizQuestionParams,
    @Body({ schema: UpdateQuizQuestionRequestSchema }) body: UpdateQuizQuestionRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuizQuestionAuthoring> {
    return withMarkdownProblems(() =>
      this.updateQuestion.execute({
        actorId: principal.userId,
        courseId: params.courseId,
        lectureId: params.lectureId,
        questionId: params.questionId,
        patch: { kind: body.kind, promptMd: body.promptMd, explanationMd: body.explanationMd },
      }),
    );
  }

  @Delete('questions/:questionId')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a question (its options too)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: QUESTION_404 })
  @ApiConflictResponse({ description: LOCKED_409 })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch' })
  async removeQuestion(
    @Param({ schema: QuizQuestionParamsSchema }) params: QuizQuestionParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.deleteQuestion.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      questionId: params.questionId,
    });
  }

  @Put('questions/:questionId/options')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({
    summary: 'Replace the answer options of a question (2–6, positions = array order)',
    description:
      'The correct-count rule (SINGLE exactly one, MULTIPLE at least one) is a readiness issue (QUIZ_QUESTION_INVALID), not a write error.',
  })
  @ApiOkResponse({ standardSchema: QuizQuestionAuthoringSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: QUESTION_404 })
  @ApiConflictResponse({ description: LOCKED_409 })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch / quiz_options_invalid' })
  putQuestionOptions(
    @Param({ schema: QuizQuestionParamsSchema }) params: QuizQuestionParams,
    @Body({ schema: PutQuizQuestionOptionsRequestSchema }) body: PutQuizQuestionOptionsRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuizQuestionAuthoring> {
    return this.putOptions.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      questionId: params.questionId,
      options: body.options,
    });
  }

  @Put('order')
  @CheckPolicy({ resource: 'course', action: 'update', id: courseIdOf })
  @ApiOperation({
    summary: 'Reorder the questions',
    description: 'Every question id exactly once; otherwise 409 order_mismatch.',
  })
  @ApiOkResponse({ standardSchema: QuizAuthoringSchema })
  @ApiBadRequestResponse({ description: 'validation_failed (duplicates, sizes)' })
  @ApiNotFoundResponse({ description: QUIZ_404 })
  @ApiConflictResponse({ description: `order_mismatch / ${LOCKED_409}` })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch' })
  reorder(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @Body({ schema: ReorderQuizQuestionsRequestSchema }) body: ReorderQuizQuestionsRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuizAuthoring> {
    return this.reorderQuestions.execute({
      actorId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      questionIds: body.questionIds,
    });
  }
}
