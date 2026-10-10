import type { AssetConsumerType } from '@udemy/db';

/** Shapes the media facade exchanges with other modules (design §3). */
export type { AssetView, MediaPurpose, SignedUrl } from '@udemy/contracts';
export type { AssetConsumerType };

/**
 * Who uses an asset (`media.asset_usages`): a working-copy lecture, a course thumbnail, or a
 * submitted revision (pin). `id` is the lecture, course or revision id.
 */
export interface AssetConsumer {
  readonly type: AssetConsumerType;
  readonly id: string;
}

/** Re-encoded image outputs that can be presigned (design D11). */
export type ImageVariant = 'w750' | 'w480' | 'poster';
export const IMAGE_VARIANTS: readonly ImageVariant[] = ['w750', 'w480', 'poster'];
