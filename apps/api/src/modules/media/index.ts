// Public facade of the media context: the only file other modules may import.
export { MediaModule } from './media.module';
export { MediaFacade } from './application/media.facade';
export type {
  AssetConsumer,
  AssetConsumerType,
  AssetView,
  ImageVariant,
  MediaPurpose,
  SignedUrl,
} from './application/dto';
// Errors the facade throws, for callers that branch on them (all map to RFC 7807 on their own).
export {
  MediaAssetNotFound,
  MediaAssetUnusable,
  MediaNotReady,
  MediaPurposeMismatch,
  RenditionNotFound,
} from './domain/media.errors';
export { HLS_CONTENT_TYPE } from './domain/hls-playlist';
