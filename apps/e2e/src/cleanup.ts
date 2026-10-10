import { assetPrefix, ObjectStorage, storageConfigFromEnv, UPLOADS_PREFIX } from '@udemy/storage';
import type pg from 'pg';

import { deleteUsers, type DeletedAsset } from './db';
import { storageEnv } from './env';

/**
 * Deletes e2e users with everything they own: rows (src/db.ts) and then the MinIO objects of
 * their media assets: `assets/{assetId}/` in the media bucket, `uploads/{ownerId}/` in the
 * uploads bucket, and any multipart upload a failed test left open there.
 */
export async function deleteUsersAndMedia(
  pool: pg.Pool,
  userIds: readonly string[],
): Promise<void> {
  const assets = await deleteUsers(pool, userIds);
  if (assets.length > 0) await deleteMediaObjects(assets);
}

async function deleteMediaObjects(assets: readonly DeletedAsset[]): Promise<void> {
  const storage = new ObjectStorage(storageConfigFromEnv(storageEnv()));
  try {
    for (const asset of assets) {
      await storage.deletePrefix({ bucket: 'media', prefix: assetPrefix(asset.id) });
    }
    for (const ownerId of new Set(assets.map((a) => a.ownerId))) {
      const prefix = `${UPLOADS_PREFIX}${ownerId}/`;
      for await (const upload of storage.listMultipartUploads({ bucket: 'uploads', prefix })) {
        await storage.abortMultipartUpload({
          bucket: 'uploads',
          key: upload.key,
          uploadId: upload.uploadId,
        });
      }
      await storage.deletePrefix({ bucket: 'uploads', prefix });
    }
  } finally {
    storage.destroy();
  }
}
