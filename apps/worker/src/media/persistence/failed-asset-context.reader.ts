import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';

/** Where a failed asset is used in the instructor's working copy (design §7 MediaFailed). */
export type FailedAssetPlacement =
  | {
      readonly kind: 'lecture';
      readonly courseId: string;
      readonly courseTitle: string;
      readonly lectureTitle: string;
    }
  | { readonly kind: 'thumbnail'; readonly courseId: string; readonly courseTitle: string };

export interface FailedAssetContext {
  /** Display-only filename the instructor uploaded (null if the asset row is gone). */
  readonly originalFilename: string | null;
  /** null when the asset is not attached to a lecture or course (e.g. detached meanwhile). */
  readonly placement: FailedAssetPlacement | null;
}

/**
 * Reads the lecture or course an asset belongs to, by `lectures.media_asset_id` /
 * `courses.thumbnail_asset_id` (both unique, design §7; schema doc §6 item 19). Runs in the
 * handler's transaction. Soft-deleted courses are ignored (their references are nulled anyway).
 */
@Injectable()
export class FailedAssetContextReader {
  async find(trx: Transaction<DB>, assetId: string): Promise<FailedAssetContext> {
    const asset = await trx
      .selectFrom('media.assets')
      .select('originalFilename')
      .where('id', '=', assetId)
      .executeTakeFirst();

    const lecture = await trx
      .selectFrom('catalog.lectures as l')
      .innerJoin('catalog.courses as c', 'c.id', 'l.courseId')
      .select(['l.title as lectureTitle', 'c.id as courseId', 'c.title as courseTitle'])
      .where('l.mediaAssetId', '=', assetId)
      .where('c.deletedAt', 'is', null)
      .executeTakeFirst();
    if (lecture !== undefined) {
      return {
        originalFilename: asset?.originalFilename ?? null,
        placement: { kind: 'lecture', ...lecture },
      };
    }

    const course = await trx
      .selectFrom('catalog.courses')
      .select(['id as courseId', 'title as courseTitle'])
      .where('thumbnailAssetId', '=', assetId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    return {
      originalFilename: asset?.originalFilename ?? null,
      placement: course === undefined ? null : { kind: 'thumbnail', ...course },
    };
  }
}
