import { Controller, Delete, Get, HttpCode, HttpStatus, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  type SessionIdParams,
  SessionIdParamsSchema,
  type SessionListResponse,
  SessionListResponseSchema,
} from '@udemy/contracts';
import {
  type ClientContext,
  CurrentClient,
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '../../../shared/auth';
import { ListMySessionsQuery } from '../application/use-cases/list-my-sessions.query';
import { RevokeSessionCommand } from '../application/use-cases/revoke-session.command';

/** `/api/v1/auth/sessions`: the caller's own sessions in every app (design §8). */
@ApiTags('auth')
@ApiBearerAuth()
@RequirePermissions('session:manage:own')
@Controller('auth/sessions')
export class SessionsController {
  constructor(
    private readonly listMySessions: ListMySessionsQuery,
    private readonly revokeSession: RevokeSessionCommand,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List my active sessions (most recently used first)' })
  @ApiOkResponse({ standardSchema: SessionListResponseSchema })
  @ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
  async list(@CurrentPrincipal() principal: Principal): Promise<SessionListResponse> {
    const sessions = await this.listMySessions.execute(principal);
    return {
      items: sessions.map((s) => ({
        id: s.id,
        app: s.app,
        device: s.device,
        ip: s.ip,
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        current: s.current,
      })),
    };
  }

  @Delete(':sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End one of my sessions' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: "session_not_found (also for other users' sessions)" })
  async revoke(
    @Param({ schema: SessionIdParamsSchema }) params: SessionIdParams,
    @CurrentPrincipal() principal: Principal,
    @CurrentClient() client: ClientContext,
  ): Promise<void> {
    await this.revokeSession.execute({ principal, sessionId: params.sessionId, client });
  }
}
