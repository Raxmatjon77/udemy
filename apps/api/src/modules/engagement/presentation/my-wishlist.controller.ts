import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Put, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type CourseIdParams,
  CourseIdParamsSchema,
  type WishlistPage,
  WishlistPageSchema,
  type WishlistQuery,
  WishlistQuerySchema,
  type WishlistStatesQuery,
  WishlistStatesQuerySchema,
  type WishlistStatesResponse,
  WishlistStatesResponseSchema,
} from '@udemy/contracts';
import { CurrentPrincipal, type Principal, RequirePermissions } from '../../../shared/auth';
import { AddToWishlistCommand } from '../application/use-cases/add-to-wishlist.command';
import { GetWishlistStatesQuery } from '../application/use-cases/get-wishlist-states.query';
import { ListWishlistQuery } from '../application/use-cases/list-wishlist.query';
import { RemoveFromWishlistCommand } from '../application/use-cases/remove-from-wishlist.command';

/**
 * `/api/v1/me/wishlist` (design §8 "Student", D19): private, scoped to the principal.
 * `wishlist:manage:own` exists in the student app only (D6).
 */
@ApiTags('engagement')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('wishlist:manage:own')
@Controller('me/wishlist')
export class MyWishlistController {
  constructor(
    private readonly listWishlist: ListWishlistQuery,
    private readonly states: GetWishlistStatesQuery,
    private readonly add: AddToWishlistCommand,
    private readonly remove: RemoveFromWishlistCommand,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My wishlist (newest first, keyset paginated)',
    description: 'Archived courses stay listed with `available: false`.',
  })
  @ApiOkResponse({ standardSchema: WishlistPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  list(
    @Query({ schema: WishlistQuerySchema }) query: WishlistQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WishlistPage> {
    return this.listWishlist.execute({
      userId: principal.userId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  // Declared before `:courseId` so `states` is never read as a course id.
  @Get('states')
  @ApiOperation({ summary: 'Wishlist state of up to 48 courses (the course-card hearts)' })
  @ApiOkResponse({ standardSchema: WishlistStatesResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  wishlistStates(
    @Query({ schema: WishlistStatesQuerySchema }) query: WishlistStatesQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WishlistStatesResponse> {
    return this.states.execute({ userId: principal.userId, courseIds: query.courseIds });
  }

  @Put(':courseId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Add a course to my wishlist (idempotent)',
    description:
      'Published courses I neither own nor am enrolled in; at most 1000 items. 200 per hour.',
  })
  @ApiNoContentResponse({ description: 'On the wishlist' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  @ApiConflictResponse({ description: 'course_not_wishlistable' })
  @ApiUnprocessableEntityResponse({ description: 'wishlist_full' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async put(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.add.execute({ userId: principal.userId, courseId: params.courseId });
  }

  @Delete(':courseId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a course from my wishlist (idempotent)' })
  @ApiNoContentResponse({ description: 'Not on the wishlist' })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async delete(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.remove.execute({ userId: principal.userId, courseId: params.courseId });
  }
}
