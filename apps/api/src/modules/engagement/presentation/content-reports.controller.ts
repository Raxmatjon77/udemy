import { Body, Controller, HttpStatus, Param, Post, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
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
  type Report,
  type ReportContentRequest,
  ReportContentRequestSchema,
  ReportSchema,
  type ReportSubjectParams,
  ReportSubjectParamsSchema,
  type ReportSubjectType,
} from '@udemy/contracts';
import type { Response } from 'express';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { ReportContentCommand } from '../application/use-cases/report-content.command';

const REPORT_DESCRIPTION =
  'The content must be visible to you and not your own. 201 for a new report, 200 (the ' +
  'existing report) for a repeat. Enough distinct reports hide it automatically. 30 per 24 h.';

/**
 * `POST /api/v1/engagement/{reviews|review-replies|questions|answers}/:subjectId/reports`
 * (design §8, D13): `content:report` exists in the student AND the instructor app. One handler
 * per subject type; `ReportContentCommand` dispatches on the type. Reviews are public; Q&A is
 * reportable by whoever can read the course's Q&A (an active learner or the owner).
 */
@ApiTags('engagement')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('content:report')
@Controller('engagement')
export class ContentReportsController {
  constructor(private readonly reportContent: ReportContentCommand) {}

  private async file(
    subjectType: ReportSubjectType,
    params: ReportSubjectParams,
    body: ReportContentRequest,
    principal: Principal,
    res: Response,
  ): Promise<Report> {
    const { report, created } = await this.reportContent.execute({
      subjectType,
      routeId: params.subjectId,
      reporterId: principal.userId,
      reason: body.reason,
      comment: body.comment ?? null,
    });
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return report;
  }

  @Post('reviews/:subjectId/reports')
  @ApiOperation({ summary: 'Report a review', description: REPORT_DESCRIPTION })
  @ApiCreatedResponse({ standardSchema: ReportSchema })
  @ApiOkResponse({ standardSchema: ReportSchema, description: 'Already reported' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'review_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'cannot_report_own_content' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  reportReview(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ReportContentRequestSchema }) body: ReportContentRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Report> {
    return this.file('REVIEW', params, body, principal, res);
  }

  @Post('review-replies/:subjectId/reports')
  @ApiOperation({
    summary: 'Report the instructor reply of a review (addressed by the review id)',
    description: REPORT_DESCRIPTION,
  })
  @ApiCreatedResponse({ standardSchema: ReportSchema })
  @ApiOkResponse({ standardSchema: ReportSchema, description: 'Already reported' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'reply_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'cannot_report_own_content' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  reportReviewReply(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ReportContentRequestSchema }) body: ReportContentRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Report> {
    return this.file('REVIEW_REPLY', params, body, principal, res);
  }

  @Post('questions/:subjectId/reports')
  @ApiOperation({ summary: 'Report a question', description: REPORT_DESCRIPTION })
  @ApiCreatedResponse({ standardSchema: ReportSchema })
  @ApiOkResponse({ standardSchema: ReportSchema, description: 'Already reported' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'question_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'cannot_report_own_content' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  reportQuestion(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ReportContentRequestSchema }) body: ReportContentRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Report> {
    return this.file('QUESTION', params, body, principal, res);
  }

  @Post('answers/:subjectId/reports')
  @ApiOperation({ summary: 'Report an answer', description: REPORT_DESCRIPTION })
  @ApiCreatedResponse({ standardSchema: ReportSchema })
  @ApiOkResponse({ standardSchema: ReportSchema, description: 'Already reported' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'answer_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'cannot_report_own_content' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  reportAnswer(
    @Param({ schema: ReportSubjectParamsSchema }) params: ReportSubjectParams,
    @Body({ schema: ReportContentRequestSchema }) body: ReportContentRequest,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Report> {
    return this.file('ANSWER', params, body, principal, res);
  }
}
