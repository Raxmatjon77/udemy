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
  type AdminRefundQueuePage,
  AdminRefundQueuePageSchema,
  type AdminRefundsQuery,
  AdminRefundsQuerySchema,
  type ApproveRefundRequest,
  ApproveRefundRequestSchema,
  type RefundDecisionResponse,
  RefundDecisionResponseSchema,
  type RefundIdParams,
  RefundIdParamsSchema,
  type RejectRefundRequest,
  RejectRefundRequestSchema,
  type RetryRefundRequest,
  RetryRefundRequestSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { ListRefundQueueQuery } from '../application/use-cases/list-refund-queue.query';
import { ReviewRefundCommand } from '../application/use-cases/review-refund.command';

/**
 * `/api/v1/admin/refunds` (design §8, admin BFF): refunds by status (REQUESTED and FAILED are
 * the work queues) and the decisions. Every decision is conditional on the current status
 * (409 `invalid_state_transition` otherwise) and written with its log row and outbox event.
 */
@ApiTags('commerce-admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('refund:review:any')
@Controller('admin/refunds')
export class AdminRefundsController {
  constructor(
    private readonly queue: ListRefundQueueQuery,
    private readonly review: ReviewRefundCommand,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Refunds in one status, oldest first (default REQUESTED)',
    description:
      "`recentRefundCount` = the buyer's other STUDENT refunds (not REJECTED) created in the " +
      '90 days before this one; 3 or more is why a request awaits review.',
  })
  @ApiOkResponse({ standardSchema: AdminRefundQueuePageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (cursor)' })
  list(
    @Query({ schema: AdminRefundsQuerySchema }) query: AdminRefundsQuery,
  ): Promise<AdminRefundQueuePage> {
    return this.queue.execute({
      status: query.status,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  @Post(':refundId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a REQUESTED refund (the course is locked, then refunded)' })
  @ApiOkResponse({ standardSchema: RefundDecisionResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'refund_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  approve(
    @Param({ schema: RefundIdParamsSchema }) params: RefundIdParams,
    @Body({ schema: ApproveRefundRequestSchema }) body: ApproveRefundRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RefundDecisionResponse> {
    return this.review.execute({
      adminId: principal.userId,
      refundId: params.refundId,
      decision: 'approve',
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
  }

  @Post(':refundId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a REQUESTED refund (the reason is mailed to the student)' })
  @ApiOkResponse({ standardSchema: RefundDecisionResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed (reason 10–2000)' })
  @ApiNotFoundResponse({ description: 'refund_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition' })
  reject(
    @Param({ schema: RefundIdParamsSchema }) params: RefundIdParams,
    @Body({ schema: RejectRefundRequestSchema }) body: RejectRefundRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RefundDecisionResponse> {
    return this.review.execute({
      adminId: principal.userId,
      refundId: params.refundId,
      decision: 'reject',
      reason: body.reason,
    });
  }

  @Post(':refundId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a FAILED refund (APPROVED again, attempt + 1, a new idempotency key)',
  })
  @ApiOkResponse({ standardSchema: RefundDecisionResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'refund_not_found' })
  @ApiConflictResponse({ description: 'invalid_state_transition / refund_already_requested' })
  retry(
    @Param({ schema: RefundIdParamsSchema }) params: RefundIdParams,
    @Body({ schema: RetryRefundRequestSchema }) body: RetryRefundRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RefundDecisionResponse> {
    return this.review.execute({
      adminId: principal.userId,
      refundId: params.refundId,
      decision: 'retry',
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
  }
}
