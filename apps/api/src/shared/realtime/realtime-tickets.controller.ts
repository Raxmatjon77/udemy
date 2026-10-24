import { Controller, Header, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type RealtimeTicket, RealtimeTicketSchema } from '@udemy/contracts';
import { AuthenticatedOnly, CurrentPrincipal, type Principal } from '../auth';
import { IssueRealtimeTicket } from './issue-realtime-ticket';

/**
 * WS tickets (design D16, §8 "Notifications"): every BFF's `POST /api/realtime/ticket` calls
 * this with the user's Bearer token; the browser then opens the socket with the ticket in the
 * handshake `auth` payload. The ticket is a bearer secret: never cached, never logged.
 */
@ApiTags('realtime')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@Controller('realtime')
export class RealtimeTicketsController {
  constructor(private readonly issueTicket: IssueRealtimeTicket) {}

  @Post('tickets')
  @AuthenticatedOnly()
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Issue a single-use WebSocket ticket (30 s) for the realtime socket',
    description:
      'Connect to `url` with path `/realtime/socket.io`, transport `websocket`, and ' +
      '`auth: { ticket }`. The ticket works once and carries the caller’s session.',
  })
  @ApiCreatedResponse({ standardSchema: RealtimeTicketSchema })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  @ApiServiceUnavailableResponse({ description: 'realtime_unavailable' })
  create(@CurrentPrincipal() principal: Principal): Promise<RealtimeTicket> {
    return this.issueTicket.execute(principal);
  }
}
