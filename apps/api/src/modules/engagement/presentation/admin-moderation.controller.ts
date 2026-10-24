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
  type ModerationQueuePage,
  ModerationQueuePageSchema,
  type ModerationQueueQuery,
  ModerationQueueQuerySchema,
  type ModerationReasonRequest,
  ModerationReasonRequestSchema,
  type ModerationSubject,
  ModerationSubjectSchema,
  type ReportSubjectParams,
  ReportSubjectParamsSchema,
  type ReportSubjectType,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { ListModerationQueueQuery } from '../application/use-cases/list-moderation-queue.query';
import { ModerateContentCommand } from '../application/use-cases/moderate-content.command';
import type { AdminModerationRouteAction } from '../domain/moderation';

const ACTION_DESCRIPTION =
  'hide: visible -> hidden (open reports actioned; on hidden content with open reports it ' +
  'confirms the hide). restore: hidden -> visible (open reports dismissed). dismiss-reports: ' +
  'open reports dismissed. The reason (10-2000) goes to the audit log. Otherwise 409.';

/**
 * `/api/v1/admin/moderation/…` (design §8 "Admin", D13; `content:moderate:any`, admin app): the
 * reports queue and the hide / restore / dismiss-reports actions on reviews, review replies,
 * questions and answers, each audited in the append-only `moderation_actions` log with the
 * admin's reason. Review replies are addressed by their REVIEW id (contracts
 * `REPORT_SUBJECT_PATHS`), in the routes and in every response, including the queue.
 */
@ApiTags('engagement-admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('content:moderate:any')
@Controller('admin/moderation')
export class AdminModerationController {
  constructor(
    private readonly queue: ListModerationQueueQuery,
    private readonly moderate: ModerateContentCommand,
  ) {}

  @Get('reports')
  @ApiOperation({
    summary: 'Moderation queue: reported subjects, most recently reported first',
    description: 'One item per subject with at least one report in `status` (default OPEN).',
  })
  @ApiOkResponse({ standardSchema: ModerationQueuePageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  reports(
    @Query({ schema: ModerationQueueQuerySchema }) query: ModerationQueueQuery,
  ): Promise<ModerationQueuePage> {
    return this.queue.execute({
      type: query.type,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  private act(
    subjectType: ReportSubjectType,
    action: AdminModerationRouteAction,
    params: ReportSubjectParams,
    body: ModerationReasonRequest,
    principal: Principal,
  ): Promise<ModerationSubject> {
    return this.moderate.execute({
      actorId: principal.userId,
      subjectType,
      routeId: params.subjectId,
      action,
      reason: body.reason,
    });
  }

  @Post('reviews/:subjectId/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hide a review', description: ACTION_DESCRIPTION })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'review_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  hideReview(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('REVIEW', 'hide', params, body, principal);
  }

  @Post('reviews/:subjectId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a review', description: ACTION_DESCRIPTION })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'review_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  restoreReview(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('REVIEW', 'restore', params, body, principal);
  }

  @Post('reviews/:subjectId/dismiss-reports')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss the open reports of a review',
    description: ACTION_DESCRIPTION,
  })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'review_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  dismissReportsReview(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('REVIEW', 'dismiss-reports', params, body, principal);
  }

  @Post('review-replies/:subjectId/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Hide the reply of a review (by review id)',
    description: ACTION_DESCRIPTION,
  })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'reply_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  hideReviewReply(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('REVIEW_REPLY', 'hide', params, body, principal);
  }

  @Post('review-replies/:subjectId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore the reply of a review (by review id)',
    description: ACTION_DESCRIPTION,
  })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'reply_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  restoreReviewReply(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('REVIEW_REPLY', 'restore', params, body, principal);
  }

  @Post('review-replies/:subjectId/dismiss-reports')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss the open reports of the reply of a review (by review id)',
    description: ACTION_DESCRIPTION,
  })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'reply_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  dismissReportsReviewReply(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('REVIEW_REPLY', 'dismiss-reports', params, body, principal);
  }

  @Post('questions/:subjectId/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hide a question', description: ACTION_DESCRIPTION })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'question_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  hideQuestion(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('QUESTION', 'hide', params, body, principal);
  }

  @Post('questions/:subjectId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a question', description: ACTION_DESCRIPTION })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'question_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  restoreQuestion(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('QUESTION', 'restore', params, body, principal);
  }

  @Post('questions/:subjectId/dismiss-reports')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss the open reports of a question',
    description: ACTION_DESCRIPTION,
  })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'question_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  dismissReportsQuestion(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('QUESTION', 'dismiss-reports', params, body, principal);
  }

  @Post('answers/:subjectId/hide')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hide an answer', description: ACTION_DESCRIPTION })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'answer_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  hideAnswer(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('ANSWER', 'hide', params, body, principal);
  }

  @Post('answers/:subjectId/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an answer', description: ACTION_DESCRIPTION })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'answer_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  restoreAnswer(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('ANSWER', 'restore', params, body, principal);
  }

  @Post('answers/:subjectId/dismiss-reports')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss the open reports of an answer',
    description: ACTION_DESCRIPTION,
  })
  @ApiOkResponse({ standardSchema: ModerationSubjectSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'answer_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  dismissReportsAnswer(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ModerationReasonRequestSchema }) body: ModerationReasonRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ModerationSubject> {
    return this.act('ANSWER', 'dismiss-reports', params, body, principal);
  }
}
