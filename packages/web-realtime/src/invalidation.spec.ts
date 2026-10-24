import { describe, expect, it } from 'vitest';

import { REALTIME_QUERY_ROOTS, realtimeInvalidationKeys } from './invalidation';

const ID = '0199c9a1-7d2e-7c4a-9b1e-000000000001';

describe('realtimeInvalidationKeys', () => {
  it('maps each server hint to its query roots', () => {
    expect(realtimeInvalidationKeys('notification.created', {})).toEqual([['notifications']]);
    expect(realtimeInvalidationKeys('notification.unread', { count: 1 })).toEqual([
      ['notifications'],
    ]);
    expect(
      realtimeInvalidationKeys('qa.changed', { courseId: ID, questionId: ID, lectureId: null }),
    ).toEqual([['qa', ID]]);
    expect(realtimeInvalidationKeys('media.changed', { assetId: ID })).toEqual([['asset', ID]]);
    expect(realtimeInvalidationKeys('session.reauth', {})).toEqual([]);
    expect(REALTIME_QUERY_ROOTS.qa(ID)).toEqual(['qa', ID]);
  });
});
