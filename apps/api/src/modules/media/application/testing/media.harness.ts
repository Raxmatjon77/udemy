import { Authorizer } from '../../../access';
import { MediaFacade } from '../media.facade';
import { MediaPlaybackService } from '../media-playback.service';
import type { MediaSettings } from '../media-settings';
import { PlaylistCache } from '../playlist-cache';
import { AbortUploadCommand } from '../use-cases/abort-upload.command';
import { CompleteUploadCommand } from '../use-cases/complete-upload.command';
import { GetAssetQuery } from '../use-cases/get-asset.query';
import { GetUploadStatusQuery } from '../use-cases/get-upload-status.query';
import { InitiateUploadCommand } from '../use-cases/initiate-upload.command';
import { ListAssetsQuery } from '../use-cases/list-assets.query';
import { PresignPartsCommand } from '../use-cases/presign-parts.command';
import {
  FakeAssetUsageRepository,
  FakeEventPublisher,
  FakeMediaAssetRepository,
  FakeMediaObjectStore,
  FakeTransactionRunner,
  FakeUploadRateLimiter,
  testSettings,
} from './media.fakes';

/** Every media use case wired to the in-memory fakes (one fresh world per call). */
export function createMediaHarness(settings: MediaSettings = testSettings()) {
  const assets = new FakeMediaAssetRepository();
  const usages = new FakeAssetUsageRepository(assets);
  const storage = new FakeMediaObjectStore();
  const events = new FakeEventPublisher();
  const tx = new FakeTransactionRunner();
  const rateLimiter = new FakeUploadRateLimiter();
  const cache = new PlaylistCache();
  // `can()` only reads the principal's permissions; ownership lookups are not used here.
  const authorizer = new Authorizer(null as never);
  const playback = new MediaPlaybackService(assets, storage, cache, settings);

  return {
    settings,
    assets,
    usages,
    storage,
    events,
    tx,
    rateLimiter,
    cache,
    initiate: new InitiateUploadCommand(assets, storage, rateLimiter, tx, settings),
    status: new GetUploadStatusQuery(assets, storage),
    presign: new PresignPartsCommand(assets, storage, rateLimiter, settings),
    complete: new CompleteUploadCommand(assets, storage, events, tx),
    abort: new AbortUploadCommand(assets, storage, tx),
    getAsset: new GetAssetQuery(assets, authorizer),
    listAssets: new ListAssetsQuery(assets, authorizer),
    facade: new MediaFacade(assets, usages, playback),
  };
}

export type MediaHarness = ReturnType<typeof createMediaHarness>;
