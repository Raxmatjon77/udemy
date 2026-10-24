import { randomUUID } from 'node:crypto';
import { type RawBuilder, sql, type Transaction } from 'kysely';
import type { DB } from '../generated/db';
import { describe, expect, it } from 'vitest';
import { upsertReview } from '../engagement/reviews';
import { createUser } from '../testing/fixtures';
import { createAnswer, createQuestion, startQuizAttempt } from '../testing/phase5-fixtures';
import {
  expectFailure,
  rollback,
  skipUnlessMigrated,
  useIntegrationDb,
} from '../testing/it-db.mjs';

/**
 * docs/phase-5-schema-design.md §0: the PG 18 behaviours V1-V10 that migration 0005 and the
 * learning/engagement SQL were written around. P5-T4 was written with Docker stopped, so this
 * spec is the probe: the first stack run proves (or disproves) each claim. The code does not
 * depend on V1, V3's empty hex, V4's substring return type or V5 (it normalises lengths
 * explicitly); the others are load-bearing. Everything runs in rolled-back transactions.
 */
const pg = useIntegrationDb({ max: 2 });

async function one<T>(trx: Transaction<DB>, q: RawBuilder<T>): Promise<T> {
  const { rows } = await q.execute(trx);
  return rows[0]!;
}

describe('PG 18 behaviours (schema doc §0)', () => {
  it('V1: varbit | varbit of different lengths raises 22026 (the code never relies on it)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      expect(
        await one(trx, sql<{ v: string }>`SELECT (B'101'::varbit | B'110'::varbit)::text AS v`),
      ).toEqual({
        v: '111',
      });
      const err = await expectFailure(trx, () =>
        sql`SELECT B'101'::varbit | B'10'::varbit`.execute(trx),
      );
      expect(err.code).toBe('22026');
    });
  });

  it('V2: bit_count(varbit) exists, returns bigint; learning.coverage_bits uses it', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      expect(
        await one(
          trx,
          sql<{ n: string; t: string }>`
            SELECT bit_count(B'1011000001'::varbit) AS n, pg_typeof(bit_count(B'1'::varbit))::text AS t`,
        ),
      ).toEqual({ n: '4', t: 'bigint' });
      const def = await one(
        trx,
        sql<{
          def: string;
        }>`SELECT pg_get_functiondef('learning.coverage_bits(varbit)'::regprocedure) AS def`,
      );
      // the native body: pg_get_functiondef shows the varbit -> bit coercion,
      // `RETURN (bit_count((p_bits)::"bit"))::integer`, not the text-count fallback
      expect(def.def).toMatch(/bit_count\(\(?p_bits\)?(::"?bit"?)?\)/);
      expect(def.def).not.toContain('replace(');
      expect(
        await one(
          trx,
          sql<{ n: number }>`SELECT learning.coverage_bits(repeat('1', 17280)::varbit) AS n`,
        ),
      ).toEqual({ n: 17280 });
    });
  });

  it('V3: text -> varbit casts (binary, hex, repeat) and the empty-hex edge', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      expect(
        await one(
          trx,
          sql<{ hex: string; bin: string; pad: string; hexLen: number }>`
            SELECT ('x' || 'a0ff')::varbit::text AS hex, '0101'::text::varbit::text AS bin,
                   repeat('0', 3)::varbit::text AS pad, length(('x' || 'a0ff')::varbit) AS hex_len`,
        ),
      ).toEqual({ hex: '1010000011111111', bin: '0101', pad: '000', hexLen: 16 });
      // a parameter bound as text and cast, exactly as progress.ts sends it
      expect(await one(trx, sql<{ v: string }>`SELECT (${'xf0'}::varbit)::text AS v`)).toEqual({
        v: '11110000',
      });
      expect(
        await one(
          trx,
          sql<{
            v: string[];
          }>`SELECT array_agg(c::varbit::text) AS v FROM unnest(${['x0f', 'x80']}::text[]) c`,
        ),
      ).toEqual({ v: ['00001111', '10000000'] });
      // Record what 'x' (empty hex) gives; the code never sends it (coverageHexLiteral -> 'x00').
      await sql`SAVEPOINT empty_hex`.execute(trx);
      let emptyHex: string;
      try {
        const r = await one(trx, sql<{ v: string }>`SELECT 'x'::varbit::text AS v`);
        emptyHex = `value:${r.v}`;
        await sql`RELEASE SAVEPOINT empty_hex`.execute(trx);
      } catch (error) {
        emptyHex = `error:${(error as { code?: string }).code}`;
        await sql`ROLLBACK TO SAVEPOINT empty_hex`.execute(trx);
      }
      expect(['value:', 'error:22P02']).toContain(emptyHex);
    });
  });

  it('V4: substring / || / length on varbit; learning.fit_coverage pads and truncates', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const r = await one(
        trx,
        sql<{
          sub: string;
          cat: string;
          catType: string;
          len: number;
          pad: string;
          cut: string;
          same: string;
          fitType: string;
        }>`
          SELECT substring(B'10110'::varbit FROM 1 FOR 3)::text AS sub,
                 (B'1'::varbit || B'00'::varbit)::text AS cat,
                 pg_typeof(B'1'::varbit || B'00'::varbit)::text AS cat_type,
                 length(B'1011010110'::varbit) AS len,
                 learning.fit_coverage(B'1'::varbit, 3)::text AS pad,
                 learning.fit_coverage(B'10110'::varbit, 3)::text AS cut,
                 learning.fit_coverage(B'101'::varbit, 3)::text AS same,
                 pg_typeof(learning.fit_coverage(B'1'::varbit, 3))::text AS fit_type`,
      );
      expect(r).toEqual({
        sub: '101',
        cat: '100',
        catType: 'bit varying',
        len: 10,
        pad: '100',
        cut: '101',
        same: '101',
        fitType: 'bit varying',
      });
      // informational: the declared return type of substring() on a bit string (the code casts it)
      const t = await one(
        trx,
        sql<{ t: string }>`SELECT pg_typeof(substring(B'10110'::varbit FROM 1 FOR 3))::text AS t`,
      );
      expect(['bit', 'bit varying']).toContain(t.t);
    });
  });

  it('V5: CASE does not evaluate the OR branch for column values that fail the condition', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const r = await one(
        trx,
        sql<{ v: string }>`
          SELECT (CASE WHEN v.a = v.b THEN v.x | v.y ELSE v.x END)::text AS v
            FROM (VALUES (1, 2, B'101'::varbit, B'10'::varbit)) v(a, b, x, y)`,
      );
      expect(r).toEqual({ v: '101' });
    });
  });

  it('V6: pg_trigger_depth() is 1 for an app UPDATE and 2 from the vote trigger', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      expect(await one(trx, sql<{ d: number }>`SELECT pg_trigger_depth() AS d`)).toEqual({ d: 0 });
      const author = await createUser(trx);
      const voter = await createUser(trx);
      const q = await createQuestion(trx, { authorId: author });
      // depth 2 (votes_count -> UPDATE questions -> counters_guard): allowed
      await sql`INSERT INTO engagement.question_votes (subject_id, user_id) VALUES (${q}, ${voter})`.execute(
        trx,
      );
      expect(
        await one(
          trx,
          sql<{ n: number }>`SELECT upvote_count AS n FROM engagement.questions WHERE id = ${q}`,
        ),
      ).toEqual({ n: 1 });
      // depth 1 (app UPDATE): rejected
      const err = await expectFailure(trx, () =>
        sql`UPDATE engagement.questions SET upvote_count = 5 WHERE id = ${q}`.execute(trx),
      );
      expect(err).toMatchObject({ code: '23514', constraint: 'questions_counters_ck' });
    });
  });

  it('V7 + V8: the partial live index is the upsert arbiter; RETURNING old.* is NULL on insert', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      const user = await createUser(trx);
      const course = randomUUID();
      const posted = await upsertReview(trx, {
        courseId: course,
        userId: user,
        rating: 3,
        body: null,
      });
      expect(posted).toMatchObject({ outcome: 'POSTED', previousRating: null });
      const edited = await upsertReview(trx, {
        courseId: course,
        userId: user,
        rating: 5,
        body: 'Great',
      });
      expect(edited).toEqual({ outcome: 'EDITED', reviewId: posted.reviewId, previousRating: 3 });
      const same = await upsertReview(trx, {
        courseId: course,
        userId: user,
        rating: 5,
        body: 'Great',
      });
      expect(same).toEqual({
        outcome: 'UNCHANGED',
        reviewId: posted.reviewId,
        previousRating: null,
      });
      // after a soft delete the partial index frees the slot: a new review gets a new id
      await sql`UPDATE engagement.reviews SET deleted_at = now(), deleted_by = ${user} WHERE id = ${posted.reviewId}`.execute(
        trx,
      );
      const again = await upsertReview(trx, {
        courseId: course,
        userId: user,
        rating: 4,
        body: null,
      });
      expect(again.outcome).toBe('POSTED');
      expect(again.reviewId).not.toBe(posted.reviewId);
      // same for replies
      const owner = await createUser(trx);
      const reply = await sql<{ id: string }>`
        INSERT INTO engagement.review_replies (review_id, author_id, body) VALUES (${again.reviewId}, ${owner}, 'Thanks')
        ON CONFLICT (review_id) WHERE deleted_at IS NULL DO UPDATE SET body = EXCLUDED.body
        RETURNING id, old.id AS old_id`.execute(trx);
      expect(reply.rows[0]).toMatchObject({ oldId: null });
    });
  });

  it('V9: the composite FK target on revision_lectures exists; V10: generated scoring columns round half away from zero', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await skipUnlessMigrated(pg, ctx);
    await rollback(pg.db, async (trx) => {
      expect(
        await one(
          trx,
          sql<{ n: number }>`
            SELECT count(*)::int AS n FROM pg_constraint
             WHERE conname = 'revision_lectures_revision_id_lecture_id_type_uq' AND contype = 'u'`,
        ),
      ).toEqual({ n: 1 });
      const user = await createUser(trx);
      const cases = [
        { q: 3, c: 2, pass: 70, score: 67, passed: false }, // 66.67 -> 67 < 70
        { q: 40, c: 27, pass: 68, score: 68, passed: true }, // 67.5 -> 68 (half away from zero)
        { q: 8, c: 1, pass: 13, score: 13, passed: true }, // 12.5 -> 13
        { q: 40, c: 28, pass: 70, score: 70, passed: true }, // exactly the pass mark
      ];
      for (const k of cases) {
        const id = await startQuizAttempt(trx, {
          userId: user,
          passPct: k.pass,
          questionIds: Array.from({ length: k.q }, () => randomUUID()),
        });
        await sql`
          UPDATE learning.quiz_attempt_questions SET is_correct = (position < ${k.c}) WHERE attempt_id = ${id}`.execute(
          trx,
        );
        await sql`
          UPDATE learning.quiz_attempts SET status = 'SUBMITTED', submitted_at = now(), correct_count = ${k.c}
           WHERE id = ${id}`.execute(trx);
        expect(
          await one(
            trx,
            sql<{
              score: number;
              passed: boolean;
            }>`SELECT score_pct AS score, passed FROM learning.quiz_attempts WHERE id = ${id}`,
          ),
        ).toEqual({ score: k.score, passed: k.passed });
      }
      // course_rating_stats: average 17/4 = 4.25 -> 4.3, totals generated
      const course = randomUUID();
      await sql`INSERT INTO engagement.course_rating_stats (course_id, count_4, count_5) VALUES (${course}, 3, 1)`.execute(
        trx,
      );
      expect(
        await one(
          trx,
          sql<{ reviewCount: number; ratingSum: string; average: string }>`
            SELECT review_count, rating_sum, average_rating::text AS average
              FROM engagement.course_rating_stats WHERE course_id = ${course}`,
        ),
      ).toEqual({ reviewCount: 4, ratingSum: '17', average: '4.3' });
      const err = await expectFailure(trx, () =>
        sql`UPDATE engagement.course_rating_stats SET review_count = 1 WHERE course_id = ${course}`.execute(
          trx,
        ),
      );
      expect(err.code).toBe('428C9'); // generated columns cannot be written
      // the answer trigger is also a nested trigger (depth 2) and may write counters
      const a = await createUser(trx);
      const q = await createQuestion(trx, { authorId: a });
      await createAnswer(trx, { questionId: q, authorId: user });
      expect(
        await one(
          trx,
          sql<{ n: number }>`SELECT answer_count AS n FROM engagement.questions WHERE id = ${q}`,
        ),
      ).toEqual({ n: 1 });
    });
  });
});
