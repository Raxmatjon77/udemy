import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
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
  type LectureParams,
  LectureParamsSchema,
  type QuizAttempt,
  type QuizAttemptDetail,
  QuizAttemptDetailSchema,
  type QuizAttemptIdParams,
  QuizAttemptIdParamsSchema,
  type QuizAttemptPage,
  QuizAttemptPageSchema,
  QuizAttemptSchema,
  type QuizAttemptsQuery,
  QuizAttemptsQuerySchema,
  type SubmitQuizAttemptRequest,
  SubmitQuizAttemptRequestSchema,
  type SubmitQuizAttemptResponse,
  SubmitQuizAttemptResponseSchema,
} from '@udemy/contracts';
import type { Response } from 'express';
import {
  CheckPolicy,
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '../../../shared/auth';
import {
  GetQuizAttemptQuery,
  ListQuizAttemptsQuery,
  StartQuizAttemptCommand,
  SubmitQuizAttemptCommand,
} from '../application/use-cases/quiz-attempts.use-cases';
import { attemptIdOf } from './learning-http';

/**
 * Quiz attempts of the student app (design §8 "Student", D6, P5-T11). Start and display carry
 * NO correctness fields (catalog's learner-safe quiz); grading is server-side against the
 * attempt's revision key; a result shows right/wrong per own answer, and the correct options and
 * explanations only for a PASSED attempt (P5-D5). IDOR: `quiz_attempt` ids resolve to their
 * owner (`@CheckPolicy`, foreign = 404) and every query is scoped to the principal.
 */
@ApiTags('learning')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiBadRequestResponse({ description: 'validation_failed' })
@Controller('me')
export class QuizAttemptsController {
  constructor(
    private readonly start: StartQuizAttemptCommand,
    private readonly list: ListQuizAttemptsQuery,
    private readonly getOne: GetQuizAttemptQuery,
    private readonly submitAttempt: SubmitQuizAttemptCommand,
  ) {}

  @Post('courses/:courseId/lectures/:lectureId/quiz-attempts')
  @RequirePermissions('quiz_attempt:create')
  @ApiOperation({
    summary: 'Start (or resume) a quiz attempt',
    description:
      '201 with a new attempt of the live revision, or 200 with the open one. The questions ' +
      'carry no answer key. 30 starts per hour.',
  })
  @ApiCreatedResponse({ standardSchema: QuizAttemptSchema })
  @ApiOkResponse({ standardSchema: QuizAttemptSchema, description: 'The open attempt (resumed)' })
  @ApiForbiddenResponse({ description: 'enrollment_required' })
  @ApiNotFoundResponse({ description: 'course_not_found / lecture_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not a quiz)' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async startAttempt(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<QuizAttempt> {
    const { attempt, created } = await this.start.execute({
      userId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
    });
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return attempt;
  }

  @Get('courses/:courseId/lectures/:lectureId/quiz-attempts')
  @RequirePermissions('quiz_attempt:read:own')
  @ApiOperation({ summary: 'My attempts of a quiz (newest first, keyset paginated)' })
  @ApiOkResponse({ standardSchema: QuizAttemptPageSchema })
  @ApiForbiddenResponse({ description: 'enrollment_required' })
  @ApiNotFoundResponse({ description: 'course_not_found / lecture_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  attempts(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @Query({ schema: QuizAttemptsQuerySchema }) query: QuizAttemptsQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuizAttemptPage> {
    return this.list.execute({
      userId: principal.userId,
      courseId: params.courseId,
      lectureId: params.lectureId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('quiz-attempts/:attemptId')
  @CheckPolicy({ resource: 'quiz_attempt', action: 'read', id: attemptIdOf })
  @ApiOperation({
    summary: 'One of my quiz attempts',
    description: 'With the result once submitted; keys and explanations only when passed.',
  })
  @ApiOkResponse({ standardSchema: QuizAttemptDetailSchema })
  @ApiNotFoundResponse({ description: 'not_found / quiz_attempt_not_found' })
  attempt(
    @Param({ schema: QuizAttemptIdParamsSchema }) params: QuizAttemptIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuizAttemptDetail> {
    return this.getOne.execute({ userId: principal.userId, attemptId: params.attemptId });
  }

  @Post('quiz-attempts/:attemptId/submit')
  @HttpCode(HttpStatus.OK)
  @CheckPolicy({ resource: 'quiz_attempt', action: 'submit', id: attemptIdOf })
  @ApiOperation({
    summary: 'Submit a quiz attempt for grading',
    description:
      'Graded server-side; unanswered questions count as wrong. A pass completes the lecture. ' +
      'A repeat returns the stored result. 60 submits per hour.',
  })
  @ApiOkResponse({ standardSchema: SubmitQuizAttemptResponseSchema })
  @ApiForbiddenResponse({ description: 'enrollment_required' })
  @ApiNotFoundResponse({ description: 'not_found / quiz_attempt_not_found' })
  @ApiConflictResponse({ description: 'attempt_not_in_progress' })
  @ApiUnprocessableEntityResponse({ description: 'quiz_answers_invalid' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  submit(
    @Param({ schema: QuizAttemptIdParamsSchema }) params: QuizAttemptIdParams,
    @Body({ schema: SubmitQuizAttemptRequestSchema }) body: SubmitQuizAttemptRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SubmitQuizAttemptResponse> {
    return this.submitAttempt.execute({
      userId: principal.userId,
      attemptId: params.attemptId,
      answers: body.answers,
    });
  }
}
