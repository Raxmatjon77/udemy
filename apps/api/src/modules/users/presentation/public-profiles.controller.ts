import { Controller, Get, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type PublicProfile,
  PublicProfileSchema,
  type UserIdParams,
  UserIdParamsSchema,
} from '@udemy/contracts';
import { Public } from '../../../shared/auth';
import { GetPublicProfileQuery } from '../application/use-cases/get-public-profile.query';

/** `/api/v1/users/:userId/profile`: what anyone may see about a user (design §8). */
@ApiTags('users')
@Controller('users')
export class PublicProfilesController {
  constructor(private readonly getPublicProfile: GetPublicProfileQuery) {}

  @Get(':userId/profile')
  @Public()
  @ApiOperation({ summary: "A user's public profile" })
  @ApiOkResponse({ standardSchema: PublicProfileSchema })
  @ApiNotFoundResponse({ description: 'user_not_found (also for banned users)' })
  profile(@Param({ schema: UserIdParamsSchema }) params: UserIdParams): Promise<PublicProfile> {
    return this.getPublicProfile.execute(params.userId);
  }
}
