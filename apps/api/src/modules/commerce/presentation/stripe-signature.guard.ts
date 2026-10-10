import { createHash } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type RawBodyRequest,
} from '@nestjs/common';
import { ErrorCode, STRIPE_SIGNATURE_HEADER } from '@udemy/contracts';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderEvent,
  WebhookSignatureInvalidError,
} from '@udemy/payments';
import type { Request } from 'express';
import { VerifiesWebhookSignature } from '../../../shared/auth';
import { CommerceSettings } from '../application/commerce-settings';

/** What the guard hands to the handler: the verified, normalized event and the body digest. */
export interface VerifiedStripeEvent {
  readonly event: ProviderEvent;
  /** SHA-256 of the exact bytes that were verified (`provider_events.payload_sha256`). */
  readonly payloadSha256: Buffer;
}

const VERIFIED = Symbol('udemy.verifiedStripeEvent');

type WebhookRequest = RawBodyRequest<Request> & { [VERIFIED]?: VerifiedStripeEvent };

/** The event `StripeSignatureGuard` verified for this request. */
export function verifiedStripeEventOf(req: Request): VerifiedStripeEvent {
  const verified = (req as WebhookRequest)[VERIFIED];
  if (verified === undefined) {
    // Only reachable if the guard was removed from the route: fail closed.
    throw new Error('StripeSignatureGuard did not run for this request');
  }
  return verified;
}

/** 400 `webhook_signature_invalid` with no detail (the reason is only logged). */
function signatureInvalid(): HttpException {
  return new HttpException({ code: ErrorCode.WebhookSignatureInvalid }, HttpStatus.BAD_REQUEST);
}

/**
 * Verifies `Stripe-Signature` over the RAW request bytes (`req.rawBody`, kept by
 * `API_APP_OPTIONS.rawBody`), never over the parsed body: re-serialized JSON with identical
 * content fails (design D10, §9). Tolerance `STRIPE_WEBHOOK_TOLERANCE_S` (300 s, both
 * directions), secret `STRIPE_WEBHOOK_SECRET`. A missing raw body (e.g. not
 * `application/json`) or any verification failure is 400 `webhook_signature_invalid`.
 */
@VerifiesWebhookSignature('stripe')
@Injectable()
export class StripeSignatureGuard implements CanActivate {
  private readonly logger = new Logger(StripeSignatureGuard.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly settings: CommerceSettings,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<WebhookRequest>();
    const raw = req.rawBody;
    if (!Buffer.isBuffer(raw)) {
      this.logger.warn('stripe webhook rejected: no raw JSON body');
      throw signatureInvalid();
    }
    let event: ProviderEvent;
    try {
      event = this.provider.verifyWebhook(
        raw,
        req.headers[STRIPE_SIGNATURE_HEADER],
        this.settings.webhookSecret,
        this.settings.webhookToleranceSeconds,
      );
    } catch (error) {
      if (error instanceof WebhookSignatureInvalidError) {
        this.logger.warn(`stripe webhook rejected: ${error.reason}`);
        throw signatureInvalid();
      }
      throw error;
    }
    req[VERIFIED] = {
      event,
      payloadSha256: createHash('sha256').update(raw).digest(),
    };
    return true;
  }
}
