import { Injectable } from '@nestjs/common';
import type { AssetView } from '@udemy/contracts';
import { type AuthorizationSubject, Authorizer } from '../../../access';
import { MediaAssetNotFound } from '../../domain/media.errors';
import { MediaAssetRepository } from '../ports/media-asset.repository';
import { toAssetView } from '../views';

export interface GetAssetInput {
  readonly principal: AuthorizationSubject;
  readonly assetId: string;
}

/**
 * `GET /media/assets/:assetId`: the owner (`media_asset:read:own`) or an admin
 * (`media_asset:read:any`). Anyone else gets 404, like a missing asset (the route's
 * `@CheckPolicy` already decided; this repeats it for non-HTTP callers).
 */
@Injectable()
export class GetAssetQuery {
  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly authorizer: Authorizer,
  ) {}

  async execute(input: GetAssetInput): Promise<AssetView> {
    const asset = await this.assets.findById(input.assetId);
    if (asset === null) throw new MediaAssetNotFound();
    const mayRead =
      this.authorizer.can(input.principal, 'media_asset:read:any') ||
      (asset.ownerId === input.principal.userId &&
        this.authorizer.can(input.principal, 'media_asset:read:own'));
    if (!mayRead) throw new MediaAssetNotFound();
    return toAssetView(asset);
  }
}
