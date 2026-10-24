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
  type AcceptAnswerRequest,
  AcceptAnswerRequestSchema,
  type Answer,
  type AnswerPage,
  AnswerPageSchema,
  type AnswerParams,
  AnswerParamsSchema,
  AnswerSchema,
  type AnswersQuery,
  AnswersQuerySchema,
  type AskQuestionRequest,
  AskQuestionRequestSchema,
  type CourseIdParams,
  CourseIdParamsSchema,
  type EditAnswerRequest,
  EditAnswerRequestSchema,
  type EditQuestionRequest,
  EditQuestionRequestSchema,
  type PostAnswerRequest,
  PostAnswerRequestSchema,
  type Question,
  type QuestionDetail,
  QuestionDetailSchema,
  type QuestionPage,
  QuestionPageSchema,
  type QuestionParams,
  QuestionParamsSchema,
  QuestionSchema,
  type QuestionsQuery,
  QuestionsQuerySchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import type { QaViewer } from '../application/qa-access';
import { AskQuestionCommand } from '../application/use-cases/ask-question.command';
import { DeleteAnswerCommand } from '../application/use-cases/delete-answer.command';
import { DeleteQuestionCommand } from '../application/use-cases/delete-question.command';
import { EditAnswerCommand } from '../application/use-cases/edit-answer.command';
import { EditQuestionCommand } from '../application/use-cases/edit-question.command';
import { GetQuestionQuery } from '../application/use-cases/get-question.query';
import { ListAnswersQuery } from '../application/use-cases/list-answers.query';
import { ListQuestionsQuery } from '../application/use-cases/list-questions.query';
import { PostAnswerCommand } from '../application/use-cases/post-answer.command';
import { SetAcceptedAnswerCommand } from '../application/use-cases/set-accepted-answer.command';
import { VoteCommand } from '../application/use-cases/vote.command';
import { EngagementProblemsInterceptor } from './engagement-problems.interceptor';

const viewerOf = (principal: Principal): QaViewer => ({
  userId: principal.userId,
  app: principal.app,
});

const ACCESS = 'enrollment_required (not an active learner nor the owner) / not_content_author';

/**
 * `/api/v1/courses/:courseId/{questions|answers}…` (design §8 "Q&A", D12): the same routes serve
 * the student and the instructor BFF (`qa:participate` in both apps). The use cases admit an
 * ACTIVE learner or the course owner (an instructor-app token only on owned courses), and
 * resolve every question and answer WITHIN the course (IDOR). Bodies are markdown
 * (422 `markdown_not_allowed` with structured `issues`); titles plain text.
 */
@ApiTags('engagement-qa')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('qa:participate')
@UseInterceptors(EngagementProblemsInterceptor)
@Controller('courses/:courseId')
export class CourseQuestionsController {
  constructor(
    private readonly listQuestions: ListQuestionsQuery,
    private readonly getQuestion: GetQuestionQuery,
    private readonly askQuestion: AskQuestionCommand,
    private readonly editQuestion: EditQuestionCommand,
    private readonly deleteQuestion: DeleteQuestionCommand,
    private readonly listAnswers: ListAnswersQuery,
    private readonly postAnswer: PostAnswerCommand,
    private readonly editAnswer: EditAnswerCommand,
    private readonly deleteAnswer: DeleteAnswerCommand,
    private readonly vote: VoteCommand,
    private readonly setAccepted: SetAcceptedAnswerCommand,
  ) {}

  /* ------------------------------------------------------------------ questions */

  @Get('questions')
  @ApiOperation({
    summary: 'Questions of a course (keyset paginated per sort)',
    description:
      'Visible questions; `lectureId` filters one lecture, `q` searches titles (>= 3 chars). ' +
      '`top` is not stable under concurrent votes: de-duplicate pages by id.',
  })
  @ApiOkResponse({ standardSchema: QuestionPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  questions(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Query({ schema: QuestionsQuerySchema }) query: QuestionsQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuestionPage> {
    return this.listQuestions.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      lectureId: query.lectureId,
      sort: query.sort,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post('questions')
  @ApiOperation({
    summary: 'Ask a question',
    description: 'The lecture (optional) must be in the live revision. 20 per 24 h.',
  })
  @ApiCreatedResponse({ standardSchema: QuestionSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'course_not_found / lecture_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'markdown_not_allowed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  ask(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Body({ schema: AskQuestionRequestSchema }) body: AskQuestionRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Question> {
    return this.askQuestion.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      lectureId: body.lectureId ?? null,
      title: body.title,
      bodyMd: body.bodyMd,
    });
  }

  @Get('questions/:questionId')
  @ApiOperation({
    summary: 'A question with its first answers page',
    description:
      'Hidden questions are visible to their author only; deleted ones with answers are placeholders.',
  })
  @ApiOkResponse({ standardSchema: QuestionDetailSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'course_not_found / question_not_found' })
  question(
    @Param({ schema: QuestionParamsSchema }) params: QuestionParams,
    @Query({ schema: AnswersQuerySchema }) query: AnswersQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<QuestionDetail> {
    return this.getQuestion.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      questionId: params.questionId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Patch('questions/:questionId')
  @ApiOperation({ summary: 'Edit my question' })
  @ApiOkResponse({ standardSchema: QuestionSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'question_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'markdown_not_allowed' })
  edit(
    @Param({ schema: QuestionParamsSchema }) params: QuestionParams,
    @Body({ schema: EditQuestionRequestSchema }) body: EditQuestionRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Question> {
    return this.editQuestion.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      questionId: params.questionId,
      title: body.title,
      bodyMd: body.bodyMd,
    });
  }

  @Delete('questions/:questionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete my question (a placeholder stays while it has answers)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'question_not_found' })
  async remove(
    @Param({ schema: QuestionParamsSchema }) params: QuestionParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.deleteQuestion.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      questionId: params.questionId,
    });
  }

  /* ------------------------------------------------------------------ answers */

  @Get('questions/:questionId/answers')
  @ApiOperation({ summary: 'Answers of a question (oldest first, keyset paginated)' })
  @ApiOkResponse({ standardSchema: AnswerPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'course_not_found / question_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  answers(
    @Param({ schema: QuestionParamsSchema }) params: QuestionParams,
    @Query({ schema: AnswersQuerySchema }) query: AnswersQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AnswerPage> {
    return this.listAnswers.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      questionId: params.questionId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post('questions/:questionId/answers')
  @ApiOperation({
    summary: 'Answer a question',
    description: "The course owner's answers carry the instructor badge. 100 per 24 h.",
  })
  @ApiCreatedResponse({ standardSchema: AnswerSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'course_not_found / question_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'markdown_not_allowed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  answer(
    @Param({ schema: QuestionParamsSchema }) params: QuestionParams,
    @Body({ schema: PostAnswerRequestSchema }) body: PostAnswerRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Answer> {
    return this.postAnswer.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      questionId: params.questionId,
      bodyMd: body.bodyMd,
    });
  }

  @Patch('answers/:answerId')
  @ApiOperation({ summary: 'Edit my answer' })
  @ApiOkResponse({ standardSchema: AnswerSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'answer_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'markdown_not_allowed' })
  editAnswerBody(
    @Param({ schema: AnswerParamsSchema }) params: AnswerParams,
    @Body({ schema: EditAnswerRequestSchema }) body: EditAnswerRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Answer> {
    return this.editAnswer.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      answerId: params.answerId,
      bodyMd: body.bodyMd,
    });
  }

  @Delete('answers/:answerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete my answer (an accepted answer reopens the question)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'answer_not_found' })
  async removeAnswer(
    @Param({ schema: AnswerParamsSchema }) params: AnswerParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.deleteAnswer.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      answerId: params.answerId,
    });
  }

  /* ------------------------------------------------------------------ votes */

  @Put('questions/:questionId/vote')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Upvote a question (idempotent; not your own). 300 per hour.' })
  @ApiNoContentResponse({ description: 'Voted' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'question_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'cannot_vote_own_content' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async voteQuestion(
    @Param({ schema: QuestionParamsSchema }) params: QuestionParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.castVote('QUESTION', params.courseId, params.questionId, principal, true);
  }

  @Delete('questions/:questionId/vote')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retract my upvote of a question (idempotent)' })
  @ApiNoContentResponse({ description: 'Retracted' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'question_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'cannot_vote_own_content' })
  async unvoteQuestion(
    @Param({ schema: QuestionParamsSchema }) params: QuestionParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.castVote('QUESTION', params.courseId, params.questionId, principal, false);
  }

  @Put('answers/:answerId/vote')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Upvote an answer (idempotent; not your own). 300 per hour.' })
  @ApiNoContentResponse({ description: 'Voted' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'answer_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'cannot_vote_own_content' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async voteAnswer(
    @Param({ schema: AnswerParamsSchema }) params: AnswerParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.castVote('ANSWER', params.courseId, params.answerId, principal, true);
  }

  @Delete('answers/:answerId/vote')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retract my upvote of an answer (idempotent)' })
  @ApiNoContentResponse({ description: 'Retracted' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'answer_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'cannot_vote_own_content' })
  async unvoteAnswer(
    @Param({ schema: AnswerParamsSchema }) params: AnswerParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.castVote('ANSWER', params.courseId, params.answerId, principal, false);
  }

  private castVote(
    subject: 'QUESTION' | 'ANSWER',
    courseId: string,
    subjectId: string,
    principal: Principal,
    on: boolean,
  ): Promise<void> {
    return this.vote.execute({ viewer: viewerOf(principal), courseId, subject, subjectId, on });
  }

  /* ------------------------------------------------------------------ accepted answer */

  @Put('questions/:questionId/accepted-answer')
  @ApiOperation({
    summary: 'Accept an answer (the question author or the course owner)',
    description:
      'The answer must be a visible answer of this question; the question becomes resolved.',
  })
  @ApiOkResponse({ standardSchema: QuestionSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'question_not_found / answer_not_found' })
  accept(
    @Param({ schema: QuestionParamsSchema }) params: QuestionParams,
    @Body({ schema: AcceptAnswerRequestSchema }) body: AcceptAnswerRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Question> {
    return this.setAccepted.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      questionId: params.questionId,
      answerId: body.answerId,
    });
  }

  @Delete('questions/:questionId/accepted-answer')
  @ApiOperation({ summary: 'Un-accept the accepted answer (reopens the question)' })
  @ApiOkResponse({ standardSchema: QuestionSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: ACCESS })
  @ApiNotFoundResponse({ description: 'question_not_found' })
  unaccept(
    @Param({ schema: QuestionParamsSchema }) params: QuestionParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Question> {
    return this.setAccepted.execute({
      viewer: viewerOf(principal),
      courseId: params.courseId,
      questionId: params.questionId,
      answerId: null,
    });
  }
}
