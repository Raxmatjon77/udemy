import { Controller, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { STRIPE_SIGNATURE_HEADER, type WebhookAck, WebhookAckSchema } from '@udemy/contracts';
import type { Request } from 'express';
import { WebhookEndpoint } from '../../../shared/auth';
import { HandleProviderEventCommand } from '../application/use-cases/handle-provider-event.command';
import { StripeSignatureGuard, verifiedStripeEventOf } from './stripe-signature.guard';

/** `@StripeWebhook()` (design §8): every marker of the Stripe webhook route in one decorator. */
export const StripeWebhook = (): MethodDecorator => WebhookEndpoint('stripe', StripeSignatureGuard);

/**
 * `POST /api/v1/webhooks/stripe` (design D10, §8 "Webhook", §9): public ingress, never through
 * a BFF. The signature over the raw bytes is the only gate (`StripeSignatureGuard`); the body
 * is never read as `@Body()`. 200 `{received: true}` also for duplicates, ignored and orphan
 * events; 500 on an unexpected failure (rolled back, Stripe retries). Tag `webhooks`: excluded
 * from the api-client generation.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class StripeWebhookController {
  constructor(private readonly handleEvent: HandleProviderEventCommand) {}

  @Post('stripe')
  @StripeWebhook()
  @ApiOperation({
    summary: 'Stripe webhook (signed raw JSON; called by Stripe, never by a BFF)',
    description:
      'Verifies Stripe-Signature over the exact request bytes (300 s tolerance), dedupes by ' +
      'event id and applies the transition in one transaction.',
  })
  @ApiHeader({ name: STRIPE_SIGNATURE_HEADER, required: true, description: 't=…,v1=…' })
  @ApiOkResponse({ standardSchema: WebhookAckSchema })
  @ApiBadRequestResponse({ description: 'webhook_signature_invalid (no detail)' })
  @ApiInternalServerErrorResponse({ description: 'unexpected failure; Stripe retries' })
  async receive(@Req() req: Request): Promise<WebhookAck> {
    const { event, payloadSha256 } = verifiedStripeEventOf(req);
    await this.handleEvent.execute(event, payloadSha256, 'WEBHOOK');
    return { received: true };
  }
}
