import { describe, expect, it } from 'vitest';
import { scriptedDb } from '../testing/scripted-db';
import {
  browsePublishedCourses,
  escapeLikePattern,
  getTransitionHead,
  listReviewQueue,
} from './queries';

describe('catalog queries', () => {
  it('escapes LIKE wildcards', () => {
    expect(escapeLikePattern('50%_off\\x')).toBe('50\\%\\_off\\\\x');
  });

  it('review queue: keyset on pending_revision_id, page 1 without a cursor', async () => {
    const s = scriptedDb();
    await listReviewQueue(s.db, { limit: 20 });
    await listReviewQueue(s.db, { limit: 20, afterRevisionId: 'r' });
    expect(s.statements[0]).not.toContain('"c"."pending_revision_id" >');
    expect(s.statements[1]).toContain('"c"."pending_revision_id" > $1');
    expect(s.statements[1]).toContain('order by "c"."pending_revision_id"');
  });

  it('browse: keyset on (first_published_at, id) DESC and the exact-precision cursor', async () => {
    const s = scriptedDb([
      { rows: [] },
      {
        rows: [
          { id: 'c1', first_published_at: new Date(), cursor_at: '2026-10-10T10:00:00.123456Z' },
        ],
      },
    ]);
    await browsePublishedCourses(s.db, { limit: 10 });
    const rows = await browsePublishedCourses(s.db, {
      limit: 10,
      after: { firstPublishedAt: '2026-10-10T10:00:00.123456Z', id: 'c0' },
      categoryIds: ['x'],
      titleContains: 'ts_',
    });
    expect(s.statements[1]).toContain('(c.first_published_at, c.id) < ($');
    expect(s.statements[1]).toContain('order by "c"."first_published_at" desc, "c"."id" desc');
    expect(s.parameters[1]).toContain('%ts\\_%');
    expect(rows[0]!.cursor).toEqual({ firstPublishedAt: '2026-10-10T10:00:00.123456Z', id: 'c1' });
  });

  it('browse with an empty category filter returns nothing without a query; limits are bounded', async () => {
    const s = scriptedDb();
    expect(await browsePublishedCourses(s.db, { limit: 10, categoryIds: [] })).toEqual([]);
    await expect(browsePublishedCourses(s.db, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(listReviewQueue(s.db, { limit: 201 })).rejects.toThrow(RangeError);
    expect(s.statements).toEqual([]);
  });

  it('getTransitionHead refuses a forked chain', async () => {
    const s = scriptedDb([
      {
        rows: [
          { id: 'a', to_status: 'DRAFT' },
          { id: 'b', to_status: 'DRAFT' },
        ],
      },
    ]);
    await expect(getTransitionHead(s.db, 'c')).rejects.toThrow(/2 transition heads/);
  });
});
