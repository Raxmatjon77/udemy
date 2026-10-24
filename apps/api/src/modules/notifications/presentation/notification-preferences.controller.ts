import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type NotificationPreferences,
  NotificationPreferencesSchema,
  type UpdateNotificationPreferencesRequest,
  UpdateNotificationPreferencesRequestSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { GetNotificationPreferencesQuery } from '../application/use-cases/get-notification-preferences.query';
import { UpdateNotificationPreferencesCommand } from '../application/use-cases/update-notification-preferences.command';

/**
 * `/api/v1/me/notification-preferences` (design §8, all three BFFs): the effective settings
 * (code defaults ⊕ overrides) per (category, channel); transactional pairs are locked.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('me/notification-preferences')
@RequirePermissions('notification:manage:own')
export class NotificationPreferencesController {
  constructor(
    private readonly getPreferences: GetNotificationPreferencesQuery,
    private readonly updatePreferences: UpdateNotificationPreferencesCommand,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My notification settings (every category × channel)' })
  @ApiOkResponse({ standardSchema: NotificationPreferencesSchema })
  get(@CurrentPrincipal() principal: Principal): Promise<NotificationPreferences> {
    return this.getPreferences.execute(principal.userId);
  }

  @Put()
  @ApiOperation({
    summary: 'Change some notification settings',
    description: 'Only the listed pairs change. Locked (transactional) pairs answer 422.',
  })
  @ApiOkResponse({ standardSchema: NotificationPreferencesSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'preference_locked' })
  put(
    @Body({ schema: UpdateNotificationPreferencesRequestSchema })
    body: UpdateNotificationPreferencesRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationPreferences> {
    return this.updatePreferences.execute({ userId: principal.userId, items: body.items });
  }
}
