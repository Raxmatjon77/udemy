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
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  CancelOrderResponseSchema,
  type MyOrdersQuery,
  MyOrdersQuerySchema,
  type OrderDetail,
  OrderDetailSchema,
  type OrderIdParams,
  OrderIdParamsSchema,
  type OrderSummaryPage,
  OrderSummaryPageSchema,
  type Receipt,
  ReceiptSchema,
  type Refund,
  type RequestRefundRequest,
  RequestRefundRequestSchema,
  RequestRefundResponseSchema,
} from '@udemy/contracts';
import {
  CheckPolicy,
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '../../../shared/auth';
import { CancelPendingOrderCommand } from '../application/use-cases/cancel-pending-order.command';
import { GetMyOrderQuery } from '../application/use-cases/get-my-order.query';
import { GetReceiptQuery } from '../application/use-cases/get-receipt.query';
import { ListMyOrdersQuery } from '../application/use-cases/list-my-orders.query';
import { RequestRefundCommand } from '../application/use-cases/request-refund.command';
import { orderIdOf } from './commerce-http';

/**
 * `/api/v1/me/orders` (design §5, §8, student BFF): reads, cancel and refund requests. Order routes carry
 * `@CheckPolicy({ resource: 'order' })` (`OrderOwnership`: the buyer), and the use cases are
 * scoped to the caller as well, so a foreign order is 404, never 403 (§9 IDOR).
 */
@ApiTags('commerce')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('me/orders')
export class MyOrdersController {
  constructor(
    private readonly listOrders: ListMyOrdersQuery,
    private readonly getOrder: GetMyOrderQuery,
    private readonly getReceipt: GetReceiptQuery,
    private readonly cancelOrder: CancelPendingOrderCommand,
    private readonly requestRefund: RequestRefundCommand,
  ) {}

  @Get()
  @RequirePermissions('order:read:own')
  @ApiOperation({ summary: 'My orders, newest first (keyset)' })
  @ApiOkResponse({ standardSchema: OrderSummaryPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (cursor)' })
  list(
    @Query({ schema: MyOrdersQuerySchema }) query: MyOrdersQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrderSummaryPage> {
    return this.listOrders.execute({
      userId: principal.userId,
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  @Get(':orderId')
  @CheckPolicy({ resource: 'order', action: 'read', id: orderIdOf })
  @ApiOperation({
    summary: 'One of my orders (lines, refund state per line, payment status)',
    description: 'The checkout success page polls this until PAID.',
  })
  @ApiOkResponse({ standardSchema: OrderDetailSchema })
  @ApiNotFoundResponse({ description: 'not_found / order_not_found' })
  get(
    @Param({ schema: OrderIdParamsSchema }) params: OrderIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrderDetail> {
    return this.getOrder.execute({ userId: principal.userId, orderId: params.orderId });
  }

  @Get(':orderId/receipt')
  @CheckPolicy({ resource: 'order', action: 'read', id: orderIdOf })
  @ApiOperation({ summary: 'The receipt of a paid order (no card details are stored)' })
  @ApiOkResponse({ standardSchema: ReceiptSchema })
  @ApiNotFoundResponse({ description: 'not_found / order_not_found' })
  @ApiConflictResponse({ description: 'order_not_paid' })
  receipt(
    @Param({ schema: OrderIdParamsSchema }) params: OrderIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Receipt> {
    return this.getReceipt.execute({ userId: principal.userId, orderId: params.orderId });
  }

  @Post(':orderId/cancel')
  @HttpCode(HttpStatus.OK)
  @CheckPolicy({ resource: 'order', action: 'read', id: orderIdOf })
  @ApiOperation({
    summary: 'Cancel my pending order (releases its coupon; a repeat is a 200)',
    description: 'Expires the Stripe session first; a session that already completed is 409.',
  })
  @ApiOkResponse({ standardSchema: CancelOrderResponseSchema })
  @ApiNotFoundResponse({ description: 'not_found / order_not_found' })
  @ApiConflictResponse({ description: 'order_not_cancelable' })
  cancel(
    @Param({ schema: OrderIdParamsSchema }) params: OrderIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrderDetail> {
    return this.cancelOrder.execute({ userId: principal.userId, orderId: params.orderId });
  }

  @Post(':orderId/refunds')
  @CheckPolicy({ resource: 'order', action: 'refund', id: orderIdOf })
  @ApiOperation({
    summary: 'Request a refund of one line of my order (full line amount)',
    description:
      'Within COMMERCE_REFUND_WINDOW_DAYS (30) of payment. Auto-approved (APPROVED: the course ' +
      'is locked again at once) unless I already have 3 or more refunds in the last 90 days ' +
      '(REQUESTED: an admin reviews it). 5 requests per 24 h.',
  })
  @ApiCreatedResponse({ standardSchema: RequestRefundResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({
    description: 'not_found / order_not_found (also a line not in the order)',
  })
  @ApiConflictResponse({ description: 'refund_already_requested' })
  @ApiUnprocessableEntityResponse({ description: 'refund_window_closed / refund_not_applicable' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  refund(
    @Param({ schema: OrderIdParamsSchema }) params: OrderIdParams,
    @Body({ schema: RequestRefundRequestSchema }) body: RequestRefundRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Refund> {
    return this.requestRefund.execute({
      userId: principal.userId,
      orderId: params.orderId,
      orderLineId: body.orderLineId,
      reasonCode: body.reasonCode,
      ...(body.comment === undefined ? {} : { comment: body.comment }),
    });
  }
}
