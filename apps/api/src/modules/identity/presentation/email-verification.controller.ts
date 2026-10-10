import { Body, Controller, HttpCode, HttpStatus, Post, UseInterceptors } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  type AcceptedResponse,
  AcceptedResponseSchema,
  type VerifyEmailRequest,
  VerifyEmailRequestSchema,
} from '@udemy/contracts';
import { AuthenticatedOnly, CurrentPrincipal, type Principal, Public } from '../../../shared/auth';
import { RequestEmailVerificationCommand } from '../application/use-cases/request-email-verification.command';
import { VerifyEmailCommand } from '../application/use-cases/verify-email.command';
import { BadRequestErrorsInterceptor } from './bad-request-errors.interceptor';

/** `/api/v1/auth/email/*`: email verification (design §8). */
@ApiTags('auth')
@Controller('auth/email')
@UseInterceptors(BadRequestErrorsInterceptor)
export class EmailVerificationController {
  constructor(
    private readonly requestVerification: RequestEmailVerificationCommand,
    private readonly verifyEmail: VerifyEmailCommand,
  ) {}

  @Post('verification-requests')
  @AuthenticatedOnly()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Send a new verification email to my address',
    description: 'The worker mails a fresh link; earlier links stop working.',
  })
  @ApiAcceptedResponse({ standardSchema: AcceptedResponseSchema })
  @ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
  @ApiConflictResponse({ description: 'email_already_verified' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited (3 per hour, + Retry-After)' })
  async requestVerificationEmail(
    @CurrentPrincipal() principal: Principal,
  ): Promise<AcceptedResponse> {
    await this.requestVerification.execute(principal);
    return { status: 'accepted' };
  }

  @Post('verify')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Verify an email address with the token from the email link',
    description: 'Idempotent: repeating it with the same, already used token answers 204.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'invalid_token / validation_failed' })
  async verify(
    @Body({ schema: VerifyEmailRequestSchema }) body: VerifyEmailRequest,
  ): Promise<void> {
    await this.verifyEmail.execute({ token: body.token });
  }
}
