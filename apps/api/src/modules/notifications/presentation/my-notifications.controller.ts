import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type MarkAllReadRequest,
  MarkAllReadRequestSchema,
  type NotificationIdParams,
  NotificationIdParamsSchema,
  type NotificationPage,
  NotificationPageSchema,
  type NotificationsQuery,
  NotificationsQuerySchema,
  type UnreadCount,
  UnreadCountSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { GetUnreadCountQuery } from '../application/use-cases/get-unread-count.query';
import { ListNotificationsQuery } from '../application/use-cases/list-notifications.query';
import { MarkAllNotificationsReadCommand } from '../application/use-cases/mark-all-notifications-read.command';
import { MarkNotificationReadCommand } from '../application/use-cases/mark-notification-read.command';
import { inboxOf } from './inbox-owner';

/**
 * `/api/v1/me/notifications…` (design §8 "Notifications", all three BFFs): the bell's inbox,
 * always the caller's own rows for the app they are signed in to (`notification:manage:own`,
 * a BASELINE permission of every app). Foreign ids answer 404 like unknown ones.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('me/notifications')
@RequirePermissions('notification:manage:own')
export class MyNotificationsController {
  constructor(
    private readonly list: ListNotificationsQuery,
    private readonly unreadCount: GetUnreadCountQuery,
    private readonly markOne: MarkNotificationReadCommand,
    private readonly markAll: MarkAllNotificationsReadCommand,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My notifications (newest first, keyset paginated)',
    description: 'The inbox of the app the caller is signed in to; `unreadOnly=true` filters.',
  })
  @ApiOkResponse({ standardSchema: NotificationPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  page(
    @Query({ schema: NotificationsQuerySchema }) query: NotificationsQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationPage> {
    return this.list.execute({
      owner: inboxOf(principal),
      unreadOnly: query.unreadOnly,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'Number of unread notifications (capped at 100 = "99+")',
  })
  @ApiOkResponse({ standardSchema: UnreadCountSchema })
  count(@CurrentPrincipal() principal: Principal): Promise<UnreadCount> {
    return this.unreadCount.execute(inboxOf(principal));
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark every notification up to and including `upToId` read',
    description:
      'Rows newer than `upToId` (arrived after the list was loaded) stay unread. Idempotent.',
  })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'notification_not_found' })
  async readAll(
    @Body({ schema: MarkAllReadRequestSchema }) body: MarkAllReadRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.markAll.execute({ owner: inboxOf(principal), upToId: body.upToId });
  }

  @Post(':notificationId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark one notification read', description: 'Idempotent.' })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'notification_not_found' })
  async read(
    @Param({ schema: NotificationIdParamsSchema }) params: NotificationIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.markOne.execute({
      owner: inboxOf(principal),
      notificationId: params.notificationId,
    });
  }
}
