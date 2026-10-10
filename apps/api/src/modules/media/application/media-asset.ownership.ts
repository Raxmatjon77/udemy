import { z } from 'zod';
import { type OwnershipResolver, OwnershipResolverFor } from '../../../shared/auth';
import { MediaAssetRepository } from './ports/media-asset.repository';

const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

/**
 * Ownership of media assets for `@CheckPolicy({ resource: 'media_asset' })` with `:own`
 * permissions (design §3, D9): the owner of a NON-purged asset. The guard runs before the param
 * pipes, so a malformed id answers "does not exist" (404) instead of reaching Postgres.
 */
@OwnershipResolverFor('media_asset')
export class MediaAssetOwnership implements OwnershipResolver {
  constructor(private readonly assets: MediaAssetRepository) {}

  async ownerOf(resourceId: string): Promise<string | null> {
    if (!isUuid(resourceId)) return null;
    return this.assets.findLiveOwnerId(resourceId);
  }
}
