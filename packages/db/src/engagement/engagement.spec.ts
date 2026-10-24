import { describe, expect, it } from 'vitest';
import { scriptedDb } from '../testing/scripted-db';
import { lockAnnouncementQuota } from './locks';
import { moderateSubject, reportContent } from './moderation';
import { castVote, listQuestions } from './qa';
import { recomputeCourseRating, upsertReview } from './reviews';

const U = '01900000-0000-7000-8000-0000000000a1';
const C = '01900000-0000-7000-8000-0000000000cc';
const S = '01900000-0000-7000-8000-0000000000dd';

describe('reviews', () => {
  it('upsertReview: partial-index arbiter, RETURNING old.*; outcome by old.id', async () => {
    const posted = scriptedDb([{ rows: [{ id: 'r1', old_id: null, previous_rating: null }] }]);
    expect(
      await upsertReview(posted.db, { courseId: C, userId: U, rating: 5, body: null }),
    ).toEqual({ outcome: 'POSTED', reviewId: 'r1', previousRating: null });
    expect(posted.statements[0]).toContain(
      'ON CONFLICT (course_id, user_id) WHERE deleted_at IS NULL DO UPDATE',
    );
    expect(posted.statements[0]).toContain(
      'RETURNING r.id, old.id AS old_id, old.rating AS previous_rating',
    );

    const edited = scriptedDb([{ rows: [{ id: 'r1', old_id: 'r1', previous_rating: 3 }] }]);
    expect(
      await upsertReview(edited.db, { courseId: C, userId: U, rating: 5, body: 'Better' }),
    ).toEqual({ outcome: 'EDITED', reviewId: 'r1', previousRating: 3 });

    const same = scriptedDb([{ rows: [] }, { rows: [{ id: 'r1' }] }]);
    expect(
      await upsertReview(same.db, { courseId: C, userId: U, rating: 5, body: 'Better' }),
    ).toEqual({ outcome: 'UNCHANGED', reviewId: 'r1', previousRating: null });
    await expect(
      upsertReview(same.db, { courseId: C, userId: U, rating: 6, body: null }),
    ).rejects.toThrow(RangeError);
  });

  it('recomputeCourseRating: ensure row, lock FOR UPDATE, recompute in a new statement', async () => {
    const at = new Date();
    const s = scriptedDb([
      {},
      {},
      {
        rows: [
          {
            course_id: C,
            review_count: 3,
            average: '4.3',
            c1: 0,
            c2: 0,
            c3: 0,
            c4: 2,
            c5: 1,
            recomputed_at: at,
          },
        ],
      },
    ]);
    const r = await s.db.transaction().execute((trx) => recomputeCourseRating(trx, C));
    expect(r).toEqual({
      courseId: C,
      reviewCount: 3,
      average: '4.3',
      counts: [0, 0, 0, 2, 1],
      recomputedAt: at,
    });
    expect(s.statements[1]).toContain('ON CONFLICT (course_id) DO NOTHING');
    expect(s.statements[2]).toContain('FOR UPDATE');
    expect(s.statements[3]).toContain(
      "deleted_at IS NULL AND moderation_status = 'VISIBLE' AND suspended_at IS NULL",
    );
    await expect(recomputeCourseRating(s.db, C)).rejects.toThrow(/transaction/);
  });
});

describe('Q&A', () => {
  it('listQuestions picks the keyset per sort and rejects a cursor of another sort', async () => {
    const s = scriptedDb([{ rows: [] }, { rows: [] }]);
    await listQuestions(s.db, {
      courseId: C,
      sort: 'top',
      limit: 20,
      after: { sort: 'top', upvoteCount: 4, id: S },
    });
    expect(s.statements[0]).toContain('(upvote_count, id) < ($2::int, $3::uuid)');
    expect(s.statements[0]).toContain('ORDER BY upvote_count DESC, id DESC');
    await listQuestions(s.db, {
      courseId: C,
      sort: 'unanswered',
      limit: 20,
      titleContains: '50%_x',
    });
    expect(s.statements[1]).toContain('answer_count = 0');
    expect(s.parameters[1]).toContain('%50\\%\\_x%');
    await expect(
      listQuestions(s.db, {
        courseId: C,
        sort: 'recent',
        limit: 20,
        after: { sort: 'top', upvoteCount: 1, id: S },
      }),
    ).rejects.toThrow(/cursor sort/);
    await expect(
      listQuestions(s.db, { courseId: C, sort: 'recent', limit: 20, titleContains: 'ab' }),
    ).rejects.toThrow(RangeError);
  });

  it('castVote is ON CONFLICT DO NOTHING on the right table', async () => {
    const s = scriptedDb([{ numAffectedRows: 1n }, { numAffectedRows: 0n }]);
    expect(await castVote(s.db, { subject: 'ANSWER', subjectId: S, userId: U })).toBe(true);
    expect(await castVote(s.db, { subject: 'ANSWER', subjectId: S, userId: U })).toBe(false);
    expect(s.statements[0]).toContain('INSERT INTO engagement.answer_votes');
    expect(s.statements[0]).toContain('ON CONFLICT (subject_id, user_id) DO NOTHING');
  });
});

describe('moderation (R9)', () => {
  it('reportContent locks the subject first and auto-hides at the threshold', async () => {
    const s = scriptedDb([
      { rows: [{ moderation_status: 'VISIBLE' }] },
      { numAffectedRows: 1n },
      { rows: [{ n: 3 }] },
      {},
      {},
      {},
    ]);
    const r = await s.db.transaction().execute((trx) =>
      reportContent(trx, {
        subjectType: 'ANSWER',
        subjectId: S,
        reporterId: U,
        reason: 'SPAM',
        comment: null,
        autoHideThreshold: 3,
      }),
    );
    expect(r).toEqual({ outcome: 'REPORTED', openReports: 3, autoHidden: true });
    expect(s.statements[1]).toContain('FROM engagement.answers');
    expect(s.statements[1]).toContain('FOR NO KEY UPDATE');
    expect(s.statements[2]).toContain('INSERT INTO engagement.answer_reports');
    expect(s.statements[4]).toContain("SET moderation_status = 'HIDDEN'");
    expect(s.statements[5]).toContain("VALUES ($1, $2, 'HIDE', $3, $4)");
    expect(s.parameters[5]).toEqual(['ANSWER', S, null, null]);
    expect(s.statements[6]).toContain('SET status = $1, resolved_at = now(), resolved_by = $2');
  });

  it('a repeat report never auto-hides; a missing subject is NOT_FOUND', async () => {
    const repeat = scriptedDb([
      { rows: [{ moderation_status: 'VISIBLE' }] },
      { numAffectedRows: 0n },
      { rows: [{ n: 5 }] },
    ]);
    const r = await repeat.db.transaction().execute((trx) =>
      reportContent(trx, {
        subjectType: 'REVIEW',
        subjectId: S,
        reporterId: U,
        reason: 'OTHER',
        comment: 'Line one\nline two',
        autoHideThreshold: 3,
      }),
    );
    expect(r).toEqual({ outcome: 'ALREADY_REPORTED', openReports: 5, autoHidden: false });
    const missing = scriptedDb([{ rows: [] }]);
    expect(
      await missing.db.transaction().execute((trx) =>
        moderateSubject(trx, {
          subjectType: 'QUESTION',
          subjectId: S,
          action: 'HIDE',
          actorId: U,
          reason: 'Clearly spam content',
        }),
      ),
    ).toEqual({ outcome: 'NOT_FOUND' });
  });
});

describe('announcement quota (R12)', () => {
  it('locks anno(course) then counts the window including deleted rows', async () => {
    const s = scriptedDb([{}, { rows: [{ posted_in_window: 4 }] }]);
    const r = await s.db.transaction().execute((trx) => lockAnnouncementQuota(trx, C));
    expect(r).toEqual({ postedInWindow: 4 });
    expect(s.parameters[1]).toEqual([1634627183, C]);
    expect(s.statements[2]).not.toContain('deleted_at');
  });
});
