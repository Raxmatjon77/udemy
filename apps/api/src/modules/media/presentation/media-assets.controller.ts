import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  type AssetIdParams,
  AssetIdParamsSchema,
  type AssetView,
  AssetViewSchema,
} from '@udemy/contracts';
import type { Request } from 'express';
import {
  AuthenticatedOnly,
  CheckPolicy,
  CurrentPrincipal,
  type Principal,
} from '../../../shared/auth';
import { GetAssetQuery } from '../application/use-cases/get-asset.query';
import { type AssetListPage, ListAssetsQuery } from '../application/use-cases/list-assets.query';
import { AssetPageSchema, type MediaAssetListQuery, MediaAssetListQuerySchema } from './media-http';

/** `/api/v1/media/assets`: asset state for the builder (owner) and moderation (admin). */
@ApiTags('media')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@Controller('media/assets')
export class MediaAssetsController {
  constructor(
    private readonly getAsset: GetAssetQuery,
    private readonly listAssets: ListAssetsQuery,
  ) {}

  /**
   * `media_asset:read:own` (own assets) OR `media_asset:read:any` (all). Route markers cannot
   * express "any of", so the route needs only a principal and ListAssetsQuery decides with the
   * Authorizer (403 `forbidden` with neither permission; design §14).
   */
  @Get()
  @AuthenticatedOnly()
  @ApiOperation({
    summary: 'Assets by ids, or a page of assets (newest first)',
    description: 'Instructors see their own assets; admins see all (and may filter by ownerId).',
  })
  @ApiOkResponse({ standardSchema: AssetPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'forbidden' })
  list(
    @Query({ schema: MediaAssetListQuerySchema }) query: MediaAssetListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AssetListPage> {
    return this.listAssets.execute({
      principal,
      ids: query.ids,
      cursor: query.cursor,
      limit: query.limit,
      ownerId: query.ownerId,
    });
  }

  @Get(':assetId')
  @CheckPolicy({
    resource: 'media_asset',
    action: 'read',
    id: (req: Request) => String(req.params.assetId),
  })
  @ApiOperation({ summary: 'One asset (status, progress, failure, renditions)' })
  @ApiOkResponse({ standardSchema: AssetViewSchema })
  @ApiNotFoundResponse({ description: "media_asset_not_found (also for other users' assets)" })
  get(
    @Param({ schema: AssetIdParamsSchema }) params: AssetIdParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AssetView> {
    return this.getAsset.execute({ principal, assetId: params.assetId });
  }
}
