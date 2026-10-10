import { Body, Controller, Headers, Post, UseInterceptors } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type CheckoutRequest,
  CheckoutRequestSchema,
  type CheckoutResponse,
  CheckoutResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { RequestValidationException } from '../../../shared/errors';
import { CheckoutCommand } from '../application/use-cases/checkout.command';
import { IdempotencyKeyRequired } from '../domain/commerce.errors';
import { CommerceProblemsInterceptor } from './commerce-problems.interceptor';

/** The `Idempotency-Key` header: missing is 400 `idempotency_key_required`, malformed 400. */
function idempotencyKeyOf(value: string | undefined): string {
  if (value === undefined || value.trim() === '') throw new IdempotencyKeyRequired();
  const parsed = IdempotencyKeySchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new RequestValidationException([
      { path: IDEMPOTENCY_KEY_HEADER, message: 'Expected a UUID.' },
    ]);
  }
  return parsed.data.toLowerCase();
}

/**
 * `POST /api/v1/me/checkout` (design §5 Checkout, §8, student BFF). The request never carries
 * a price: `expectedTotal` is only compared with the server's quote (§9).
 */
@ApiTags('commerce')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden / email_not_verified' })
@UseInterceptors(CommerceProblemsInterceptor)
@Controller('me')
export class CheckoutController {
  constructor(private readonly checkoutCommand: CheckoutCommand) {}

  @Post('checkout')
  @RequirePermissions('order:create')
  @ApiOperation({
    summary: 'Check out my cart (Stripe Checkout redirect, or PAID for a zero total)',
    description:
      'One UUID Idempotency-Key per attempt: the same key resumes the same order (and its ' +
      'session); retry it after a 503. PENDING_PAYMENT answers the hosted checkoutUrl; a ' +
      'zero-total order (100% coupons) is PAID at once with checkoutUrl null.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'A UUID per attempt' })
  @ApiCreatedResponse({ standardSchema: CheckoutResponseSchema })
  @ApiBadRequestResponse({ description: 'idempotency_key_required / validation_failed' })
  @ApiConflictResponse({
    description:
      'checkout_in_progress {orderId, checkoutUrl} / price_changed {quote} / cart_changed {quote}',
  })
  @ApiUnprocessableEntityResponse({
    description: 'cart_empty / idempotency_key_reused / amount_below_minimum',
  })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  @ApiServiceUnavailableResponse({ description: 'payment_provider_unavailable (retry, same key)' })
  checkout(
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
    @Body({ schema: CheckoutRequestSchema }) body: CheckoutRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CheckoutResponse> {
    return this.checkoutCommand.execute({
      userId: principal.userId,
      idempotencyKey: idempotencyKeyOf(idempotencyKey),
      expectedTotal: body.expectedTotal,
    });
  }
}
