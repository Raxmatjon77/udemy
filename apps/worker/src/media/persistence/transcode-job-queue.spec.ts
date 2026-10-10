import { scriptedDb } from '@udemy/db/testing';
import { describe, expect, it } from 'vitest';
import { fakeConfig } from '../../identity/testing/identity-mail.fakes';
import { TranscodeJobQueue } from './transcode-job-queue';

const ASSET = '0199c8a0-0000-7000-8000-0000000000a1';

describe('TranscodeJobQueue', () => {
  it('writes TRANSCODER_MAX_ATTEMPTS into the job row, in the caller transaction', async () => {
    const scripted = scriptedDb([{ numAffectedRows: 1n }]);
    const queue = new TranscodeJobQueue(fakeConfig({ TRANSCODER_MAX_ATTEMPTS: 4 }));

    const created = await scripted.db.transaction().execute((trx) => queue.enqueue(trx, ASSET));

    expect(created).toBe(true);
    expect(scripted.statements[0]).toBe('BEGIN');
    expect(scripted.statements[1]).toMatch(
      /^insert into media\.transcode_jobs \(asset_id, max_attempts\)/i,
    );
    expect(scripted.parameters[1]).toEqual([4, ASSET]);
    expect(scripted.statements.at(-1)).toBe('COMMIT');
  });

  it('reports an existing job (ON CONFLICT DO NOTHING) as false', async () => {
    const scripted = scriptedDb([{ numAffectedRows: 0n }]);
    const queue = new TranscodeJobQueue(fakeConfig({ TRANSCODER_MAX_ATTEMPTS: 3 }));
    await expect(
      scripted.db.transaction().execute((trx) => queue.enqueue(trx, ASSET)),
    ).resolves.toBe(false);
  });
});
