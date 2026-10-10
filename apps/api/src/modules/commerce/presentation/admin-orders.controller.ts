import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
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
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AcceptPaymentRequest,
  AcceptPaymentRequestSchema,
  AcceptPaymentResponseSchema,
  type AdminOrderDetail,
  AdminOrderDetailSchema,
  type AdminOrderPage,
  AdminOrderPageSchema,
  type AdminOrdersQuery,
  AdminOrdersQuerySchema,
  type AdminRefundOrderLinesRequest,
  AdminRefundOrderLinesRequestSchema,
  type AdminRefundOrderLinesResponse,
  AdminRefundOrderLinesResponseSchema,
  type OrderIdParams,
  OrderIdParamsSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { AcceptPaymentCommand } from '../application/use-cases/accept-payment.command';
import { AdminRefundOrderLinesCommand } from '../application/use-cases/admin-refund-order-lines.command';
import { GetAdminOrderQuery } from '../application/use-cases/get-admin-order.query';
import { SearchAdminOrdersQuery } from '../application/use-cases/search-admin-orders.query';

/**
 * `/api/v1/admin/orders` (design §8, admin BFF): search (order number, buyer email, user,
 * course, status, date), the full order view with its merged timeline, refunding lines, and
 * accepting a PAYMENT_REVIEW payment. `:any` permissions exist only in the admin app (D6).
 */
@ApiTags('commerce-admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly searchOrders: SearchAdminOrdersQuery,
    private readonly getOrder: GetAdminOrderQuery,
    private readonly refundLines: AdminRefundOrderLinesCommand,
    private readonly acceptPayment: AcceptPaymentCommand,
  ) {}

  @Get()
  @RequirePermissions('order:read:any')
  @ApiOperation({
    summary: 'Search orders, newest first (keyset)',
    description:
      '`q` = order number; `buyerEmail` = a case-insensitive substring of the buyer email ' +
      '(at least 3 characters). Every filter is combined with AND.',
  })
  @ApiOkResponse({ standardSchema: AdminOrderPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (cursor)' })
  list(
    @Query({ schema: AdminOrdersQuerySchema }) query: AdminOrdersQuery,
  ): Promise<AdminOrderPage> {
    return this.searchOrders.execute(query);
  }

  @Get(':orderId')
  @RequirePermissions('order:read:any')
  @ApiOperation({
    summary: 'One order: lines with the revenue split, payment, refunds, provider events, timeline',
  })
  @ApiOkResponse({ standardSchema: AdminOrderDetailSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'order_not_found' })
  get(@Param({ schema: OrderIdParamsSchema }) params: OrderIdParams): Promise<AdminOrderDetail> {
    return this.getOrder.execute(params.orderId);
  }

  @Post(':orderId/refunds')
  @RequirePermissions('order:refund:any')
  @ApiOperation({
    summary: 'Refund order lines (APPROVED at once; ignores the refund window)',
    description:
      'One refund per line, all or none, with the admin reason on each. A PAYMENT_REVIEW order ' +
      'is refunded as a whole (every paid line).',
  })
  @ApiCreatedResponse({ standardSchema: AdminRefundOrderLinesResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'order_not_found (also a line not in the order)' })
  @ApiConflictResponse({ description: 'refund_already_requested' })
  @ApiUnprocessableEntityResponse({ description: 'refund_not_applicable' })
  refund(
    @Param({ schema: OrderIdParamsSchema }) params: OrderIdParams,
    @Body({ schema: AdminRefundOrderLinesRequestSchema }) body: AdminRefundOrderLinesRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AdminRefundOrderLinesResponse> {
    return this.refundLines.execute({
      adminId: principal.userId,
      orderId: params.orderId,
      orderLineIds: body.orderLineIds,
      reason: body.reason,
    });
  }

  @Post(':orderId/accept-payment')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:refund:any')
  @ApiOperation({
    summary: 'Accept a payment held in PAYMENT_REVIEW (amount mismatch): PAID with enrollments',
  })
  @ApiOkResponse({ standardSchema: AcceptPaymentResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'order_not_found' })
  @ApiConflictResponse({
    description: 'invalid_state_transition (not PAYMENT_REVIEW, or being refunded)',
  })
  accept(
    @Param({ schema: OrderIdParamsSchema }) params: OrderIdParams,
    @Body({ schema: AcceptPaymentRequestSchema }) body: AcceptPaymentRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AdminOrderDetail> {
    return this.acceptPayment.execute({
      adminId: principal.userId,
      orderId: params.orderId,
      reason: body.reason,
    });
  }
}
