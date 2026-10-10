import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AuthResult,
  AuthResultSchema,
  type LoginRequest,
  LoginRequestSchema,
  type LogoutRequest,
  LogoutRequestSchema,
  type RefreshRequest,
  RefreshRequestSchema,
  type RefreshResult,
  RefreshResultSchema,
  type SignupRequest,
  SignupRequestSchema,
  type SignupResponse,
  SignupResponseSchema,
} from '@udemy/contracts';
import {
  AllowClients,
  AuthenticatedOnly,
  type ClientContext,
  CurrentClient,
  CurrentPrincipal,
  type Principal,
  Public,
} from '../../../shared/auth';
import { LoginCommand } from '../application/use-cases/login.command';
import { LogoutCommand } from '../application/use-cases/logout.command';
import { LogoutAllSessionsCommand } from '../application/use-cases/logout-all-sessions.command';
import { RefreshSessionCommand } from '../application/use-cases/refresh-session.command';
import { RegisterUserCommand } from '../application/use-cases/register-user.command';

/**
 * `/api/v1/auth/*` session endpoints (design §8). Called only by the BFFs (client credentials
 * on every route); login/refresh return the refresh token in the body, which the BFF keeps in
 * an httpOnly cookie and never forwards to the browser.
 *
 * The email/password endpoints (verification, forgot, reset, change) are T9.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerUser: RegisterUserCommand,
    private readonly login: LoginCommand,
    private readonly refreshSession: RefreshSessionCommand,
    private readonly logout: LogoutCommand,
    private readonly logoutAll: LogoutAllSessionsCommand,
  ) {}

  @Post('signup')
  @Public()
  @AllowClients('student')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Create an account (student app only)',
    description:
      'Always 202 for a well-formed request, also when the email already has an account ' +
      '(the owner gets an email instead). Response time is padded to a fixed floor.',
  })
  @ApiAcceptedResponse({ standardSchema: SignupResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'client_not_allowed (not the student BFF)' })
  @ApiUnprocessableEntityResponse({ description: 'weak_password / validation_failed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited (+ Retry-After)' })
  async signup(
    @Body({ schema: SignupRequestSchema }) body: SignupRequest,
    @CurrentClient() client: ClientContext,
  ): Promise<SignupResponse> {
    await this.registerUser.execute({ ...body, client });
    return { status: 'accepted' };
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in to the calling BFF app',
    description:
      'Uses X-Client-IP / X-Client-User-Agent of the BFF. account_banned and ' +
      'app_access_denied are only returned after a correct password.',
  })
  @ApiOkResponse({ standardSchema: AuthResultSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnauthorizedResponse({ description: 'invalid_credentials' })
  @ApiForbiddenResponse({ description: 'account_banned / app_access_denied' })
  @ApiTooManyRequestsResponse({ description: 'too_many_attempts (+ Retry-After)' })
  async logIn(
    @Body({ schema: LoginRequestSchema }) body: LoginRequest,
    @CurrentClient() client: ClientContext,
  ): Promise<AuthResult> {
    const result = await this.login.execute({ ...body, client });
    return {
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
      refreshToken: result.refreshToken,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
      sessionId: result.sessionId,
      user: result.user,
    };
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token and mint a new access token',
    description:
      'refreshToken/refreshTokenExpiresAt are absent when a parallel refresh already rotated ' +
      'the token less than 10 s ago (keep the current refresh token).',
  })
  @ApiOkResponse({ standardSchema: RefreshResultSchema })
  @ApiUnauthorizedResponse({ description: 'invalid_refresh_token (every failure cause)' })
  async refresh(
    @Body({ schema: RefreshRequestSchema }) body: RefreshRequest,
    @CurrentClient() client: ClientContext,
  ): Promise<RefreshResult> {
    const result = await this.refreshSession.execute({ refreshToken: body.refreshToken, client });
    return {
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
      ...(result.refreshToken === undefined || result.refreshTokenExpiresAt === undefined
        ? {}
        : {
            refreshToken: result.refreshToken,
            refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
          }),
    };
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End the session of a refresh token (idempotent, always 204)' })
  @ApiNoContentResponse({ description: 'Always, also for unknown or already-revoked tokens' })
  async logOut(
    @Body({ schema: LogoutRequestSchema }) body: LogoutRequest,
    @CurrentClient() client: ClientContext,
  ): Promise<void> {
    await this.logout.execute({ refreshToken: body.refreshToken, client });
  }

  @Post('logout-all')
  @AuthenticatedOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'End every session of the user, in every app' })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
  async logOutEverywhere(
    @CurrentPrincipal() principal: Principal,
    @CurrentClient() client: ClientContext,
  ): Promise<void> {
    await this.logoutAll.execute({ principal, client });
  }
}
