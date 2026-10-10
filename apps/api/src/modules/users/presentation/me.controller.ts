import { Body, Controller, Get, Patch } from '@nestjs/common';
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
  type MeResponse,
  MeResponseSchema,
  type Profile,
  ProfileSchema,
  type UpdateProfileRequest,
  UpdateProfileRequestSchema,
} from '@udemy/contracts';
import {
  AuthenticatedOnly,
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '../../../shared/auth';
import { GetMeQuery } from '../application/use-cases/get-me.query';
import { GetMyProfileQuery } from '../application/use-cases/get-my-profile.query';
import { UpdateMyProfileCommand } from '../application/use-cases/update-my-profile.command';

/** `/api/v1/me`: the caller's account and profile (design §8), in any app. */
@ApiTags('me')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@Controller('me')
export class MeController {
  constructor(
    private readonly getMe: GetMeQuery,
    private readonly getMyProfile: GetMyProfileQuery,
    private readonly updateMyProfile: UpdateMyProfileCommand,
  ) {}

  @Get()
  @AuthenticatedOnly()
  @ApiOperation({
    summary: 'Who am I',
    description:
      '`roles` is the current state; `permissions` are what this access token may do in the ' +
      'calling app.',
  })
  @ApiOkResponse({ standardSchema: MeResponseSchema })
  me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    return this.getMe.execute(principal);
  }

  @Get('profile')
  @RequirePermissions('profile:read:own')
  @ApiOperation({ summary: 'My profile (defaults until the first update)' })
  @ApiOkResponse({ standardSchema: ProfileSchema })
  @ApiForbiddenResponse({ description: 'forbidden' })
  profile(@CurrentPrincipal() principal: Principal): Promise<Profile> {
    return this.getMyProfile.execute(principal.userId);
  }

  @Patch('profile')
  @RequirePermissions('profile:update:own')
  @ApiOperation({
    summary: 'Update my profile',
    description: 'At least one field. `null` clears headline/bio; displayName cannot be cleared.',
  })
  @ApiOkResponse({ standardSchema: ProfileSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'forbidden' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (domain rules)' })
  updateProfile(
    @Body({ schema: UpdateProfileRequestSchema }) body: UpdateProfileRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Profile> {
    return this.updateMyProfile.execute({ userId: principal.userId, ...body });
  }
}
