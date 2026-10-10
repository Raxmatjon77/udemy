import { Body, Controller, HttpCode, HttpStatus, Post, UseInterceptors } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AcceptedResponse,
  AcceptedResponseSchema,
  type ChangePasswordRequest,
  ChangePasswordRequestSchema,
  type ForgotPasswordRequest,
  ForgotPasswordRequestSchema,
  type ResetPasswordRequest,
  ResetPasswordRequestSchema,
} from '@udemy/contracts';
import {
  AuthenticatedOnly,
  type ClientContext,
  CurrentClient,
  CurrentPrincipal,
  type Principal,
  Public,
} from '../../../shared/auth';
import { ChangePasswordCommand } from '../application/use-cases/change-password.command';
import { RequestPasswordResetCommand } from '../application/use-cases/request-password-reset.command';
import { ResetPasswordCommand } from '../application/use-cases/reset-password.command';
import { BadRequestErrorsInterceptor } from './bad-request-errors.interceptor';

/** `/api/v1/auth/password/*`: forgot, reset and change password (design §8). */
@ApiTags('auth')
@Controller('auth/password')
@UseInterceptors(BadRequestErrorsInterceptor)
export class PasswordController {
  constructor(
    private readonly requestReset: RequestPasswordResetCommand,
    private readonly resetPassword: ResetPasswordCommand,
    private readonly changePassword: ChangePasswordCommand,
  ) {}

  @Post('forgot')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Email a password-reset link',
    description:
      'Always 202, whether or not the address has an account and also when rate-limited ' +
      '(the request is then dropped). Response time is padded to a fixed floor.',
  })
  @ApiAcceptedResponse({ standardSchema: AcceptedResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed (shape only)' })
  async forgot(
    @Body({ schema: ForgotPasswordRequestSchema }) body: ForgotPasswordRequest,
    @CurrentClient() client: ClientContext,
  ): Promise<AcceptedResponse> {
    await this.requestReset.execute({ email: body.email, client });
    return { status: 'accepted' };
  }

  @Post('reset')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Set a new password with the token from the reset email',
    description: 'Signs the account out everywhere and marks the email verified.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'invalid_token / validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'weak_password' })
  async reset(
    @Body({ schema: ResetPasswordRequestSchema }) body: ResetPasswordRequest,
    @CurrentClient() client: ClientContext,
  ): Promise<void> {
    await this.resetPassword.execute({
      token: body.token,
      newPassword: body.newPassword,
      client,
    });
  }

  @Post('change')
  @AuthenticatedOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change my password',
    description: 'Signs out every other session; the calling session stays signed in.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'invalid_current_password / validation_failed' })
  @ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
  @ApiUnprocessableEntityResponse({ description: 'weak_password' })
  async change(
    @Body({ schema: ChangePasswordRequestSchema }) body: ChangePasswordRequest,
    @CurrentPrincipal() principal: Principal,
    @CurrentClient() client: ClientContext,
  ): Promise<void> {
    await this.changePassword.execute({
      principal,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      client,
    });
  }
}
