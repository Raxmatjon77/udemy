import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type AdminUserDetail,
  AdminUserDetailSchema,
  type AdminUserPage,
  AdminUserPageSchema,
  type AdminUsersQuery,
  AdminUsersQuerySchema,
  type BanUserRequest,
  BanUserRequestSchema,
  type BanUserResponse,
  BanUserResponseSchema,
  type UnbanUserRequest,
  UnbanUserRequestSchema,
  type UnbanUserResponse,
  UnbanUserResponseSchema,
  type UserIdParams,
  UserIdParamsSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { AdminGetUserQuery } from '../application/use-cases/admin-get-user.query';
import { AdminSearchUsersQuery } from '../application/use-cases/admin-search-users.query';
import { BanUserCommand } from '../application/use-cases/ban-user.command';
import { UnbanUserCommand } from '../application/use-cases/unban-user.command';

/** `/api/v1/admin/users`: search, detail, ban and unban (design §8, admin app). */
@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly searchUsers: AdminSearchUsersQuery,
    private readonly getUser: AdminGetUserQuery,
    private readonly banUser: BanUserCommand,
    private readonly unbanUser: UnbanUserCommand,
  ) {}

  @Get()
  @RequirePermissions('user:read:any')
  @ApiOperation({ summary: 'Search users (newest first, keyset paginated)' })
  @ApiOkResponse({ standardSchema: AdminUserPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (foreign cursor)' })
  search(@Query({ schema: AdminUsersQuerySchema }) query: AdminUsersQuery): Promise<AdminUserPage> {
    return this.searchUsers.execute(query);
  }

  @Get(':userId')
  @RequirePermissions('user:read:any')
  @ApiOperation({ summary: 'A user with roles, ban history and active session count' })
  @ApiOkResponse({ standardSchema: AdminUserDetailSchema })
  @ApiNotFoundResponse({ description: 'user_not_found' })
  get(@Param({ schema: UserIdParamsSchema }) params: UserIdParams): Promise<AdminUserDetail> {
    return this.getUser.execute(params.userId);
  }

  @Post(':userId/ban')
  @RequirePermissions('user:ban:any')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ban: revokes every session at once' })
  @ApiOkResponse({ standardSchema: BanUserResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'user_not_found' })
  @ApiConflictResponse({ description: 'already_banned / cannot_ban_self / target_is_admin' })
  ban(
    @Param({ schema: UserIdParamsSchema }) params: UserIdParams,
    @Body({ schema: BanUserRequestSchema }) body: BanUserRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BanUserResponse> {
    return this.banUser.execute({
      actorId: principal.userId,
      userId: params.userId,
      reason: body.reason,
    });
  }

  @Post(':userId/unban')
  @RequirePermissions('user:ban:any')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lift the active ban (returns the lifted ban)' })
  @ApiOkResponse({ standardSchema: UnbanUserResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'user_not_found' })
  @ApiConflictResponse({ description: 'not_banned' })
  unban(
    @Param({ schema: UserIdParamsSchema }) params: UserIdParams,
    @Body({ schema: UnbanUserRequestSchema }) body: UnbanUserRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<UnbanUserResponse> {
    return this.unbanUser.execute({
      actorId: principal.userId,
      userId: params.userId,
      reason: body.reason,
    });
  }
}
