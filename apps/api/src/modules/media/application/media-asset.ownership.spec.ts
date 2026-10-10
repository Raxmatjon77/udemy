import { describe, expect, it } from 'vitest';
import { MediaAssetOwnership } from './media-asset.ownership';
import { assetRecord, FakeMediaAssetRepository } from './testing/media.fakes';

describe('MediaAssetOwnership', () => {
  it('returns the owner of a live asset, null for purged, unknown or malformed ids', async () => {
    const assets = new FakeMediaAssetRepository();
    const live = assets.add(assetRecord({ ownerId: '00000000-0000-7000-8000-00000000aaaa' }));
    const purged = assets.add(assetRecord({ status: 'READY', purged: true }));
    const resolver = new MediaAssetOwnership(assets);

    expect(await resolver.ownerOf(live.id)).toBe('00000000-0000-7000-8000-00000000aaaa');
    expect(await resolver.ownerOf(purged.id)).toBeNull();
    expect(await resolver.ownerOf('00000000-0000-7000-8000-000000000999')).toBeNull();
    expect(await resolver.ownerOf("1' or 1=1 --")).toBeNull();
  });
});
