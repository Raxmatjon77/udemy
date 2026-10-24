import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { type UnsubscribeRequest, UnsubscribeRequestSchema } from '@udemy/contracts';
import { AllowClients, type ClientContext, CurrentClient, Public } from '../../../shared/auth';
import { UnsubscribeCommand } from '../application/use-cases/unsubscribe.command';
import { UnsubscribeErrorsInterceptor } from './unsubscribe-errors.interceptor';

/**
 * `POST /api/v1/notifications/unsubscribe {token}` (design §8 "Public", D14): the one and only
 * unsubscribe endpoint of the api, without a session (C + `@Public`, student BFF). Two callers
 * reach it through the student BFF, both with the token in the JSON body (never in an api URL,
 * so it never reaches an access log):
 *
 * - the `/unsubscribe#token=…` page (it reads the fragment and POSTs it);
 * - the RFC 8058 one-click relay: the e-mail's `List-Unsubscribe` URL is a student BFF route
 *   (design §14 "One-click unsubscribe"), which forwards the token here.
 */
@ApiTags('notifications')
@Controller('notifications')
@UseInterceptors(UnsubscribeErrorsInterceptor)
export class UnsubscribeController {
  constructor(private readonly unsubscribe: UnsubscribeCommand) {}

  @Post('unsubscribe')
  @Public()
  @AllowClients('student')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'One-click e-mail unsubscribe (token from the e-mail)',
    description:
      'Turns e-mails of one category off for the token’s user. No session. Idempotent. ' +
      '30 per hour per IP.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'invalid_unsubscribe_token / validation_failed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async post(
    @Body({ schema: UnsubscribeRequestSchema }) body: UnsubscribeRequest,
    @CurrentClient() client: ClientContext,
  ): Promise<void> {
    await this.unsubscribe.execute({ token: body.token, ip: client.ip });
  }
}
