import type { Logger } from '@nestjs/common';
import { type DB, type Kysely, markSourcesDeleted } from '@udemy/db';
import type { ObjectStorage } from '@udemy/storage';

/**
 * Deletes the quarantined sources of terminally FAILED assets (design §5), after the FAILED
 * transaction committed, then records `source_deleted_at`. Best effort: the worker's cleanup job
 * has a FAILED-source backstop (`findStaleFailedSources`).
 */
export async function deleteFailedSources(
  db: Kysely<DB>,
  storage: ObjectStorage,
  sources: readonly { assetId: string; sourceKey: string }[],
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  const deleted: string[] = [];
  for (const { assetId, sourceKey } of sources) {
    try {
      await storage.deleteObject({ bucket: 'uploads', key: sourceKey });
      deleted.push(assetId);
    } catch (error) {
      logger.warn({ err: error, assetId }, 'Could not delete the source of a failed asset');
    }
  }
  try {
    await markSourcesDeleted(db, deleted);
  } catch (error) {
    logger.warn({ err: error, assetIds: deleted }, 'Could not mark failed sources as deleted');
  }
}
