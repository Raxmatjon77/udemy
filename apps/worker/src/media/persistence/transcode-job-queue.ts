import { Injectable } from '@nestjs/common';
import { type DB, enqueueTranscodeJob, type Transaction } from '@udemy/db';

/**
 * `media.transcode_jobs` from the worker's side (design D6). A class so handler unit tests can
 * substitute a fake; the SQL itself lives in `@udemy/db` (§14 "operational SQL").
 */
@Injectable()
export class TranscodeJobQueue {
  /**
   * Inserts the QUEUED job in the caller's transaction (`ON CONFLICT (asset_id) DO NOTHING`; the
   * insert fires `pg_notify('media_transcode')` for the transcoder). Returns false when the job
   * already exists or the asset is not UPLOADED / is purged.
   */
  enqueue(trx: Transaction<DB>, assetId: string): Promise<boolean> {
    return enqueueTranscodeJob(trx, assetId);
  }
}
