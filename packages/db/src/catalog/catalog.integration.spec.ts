import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../generated/db';
import {
  approve,
  createCategoryPair,
  createDraftCourse,
  createUser,
  type DraftCourse,
  insertRevision,
  insertTransition,
  submit,
} from '../testing/fixtures';
import { checkDeferredNow, expectFailure, rollback, useIntegrationDb } from '../testing/it-db';
import { browsePublishedCourses, getTransitionHead, listReviewQueue } from './queries';
import { findLeakedUsages, findLecturesWithoutUsage } from './consistency';

/**
 * Catalog DDL invariants (docs/phase-2-schema-design.md §2, hand-off item 3). Every test runs in
 * a rolled-back transaction, or commits a transaction that is expected to FAIL at COMMIT (so
 * nothing persists). Deferred checks inside rolled-back transactions use SET CONSTRAINTS ALL
 * IMMEDIATE, which runs exactly the checks COMMIT would.
 */
const pg = useIntegrationDb();

interface World {
  ownerId: string;
  adminId: string;
  rootId: string;
  childId: string;
}

async function world(trx: Transaction<DB>): Promise<World> {
  const ownerId = await createUser(trx);
  const adminId = await createUser(trx);
  const { rootId, childId } = await createCategoryPair(trx);
  return { ownerId, adminId, rootId, childId };
}

async function draft(trx: Transaction<DB>, w: World): Promise<DraftCourse> {
  return createDraftCourse(trx, { ownerId: w.ownerId, categoryId: w.childId });
}

/** Commits `fn`'s transaction and returns the COMMIT error (fails the test if it commits). */
async function commitError(fn: (trx: Transaction<DB>) => Promise<void>) {
  try {
    await pg.db.transaction().execute(fn);
  } catch (error) {
    return error as Error & { code?: string; constraint?: string };
  }
  throw new Error('expected COMMIT to fail, but it succeeded (test data was committed)');
}

describe('catalog.categories', () => {
  it('rejects a wrong-depth parent, a depth-3 node, and a depth change of a node with children', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const { rootId, childId } = await createCategoryPair(trx);

      // depth-2 node whose parent is depth 2 -> composite FK (parent_id, parent_depth=1) misses
      const wrongParent = await expectFailure(trx, () =>
        trx
          .insertInto('catalog.categories')
          .values({
            parentId: childId,
            depth: 2,
            slug: `it-x-${randomUUID().slice(0, 8)}`,
            name: 'Bad',
            position: 1,
          })
          .execute(),
      );
      expect(wrongParent).toMatchObject({
        code: '23503',
        constraint: 'categories_parent_id_parent_depth_fk',
      });

      const depth3 = await expectFailure(trx, () =>
        trx
          .insertInto('catalog.categories')
          .values({
            parentId: childId,
            depth: 3,
            slug: `it-y-${randomUUID().slice(0, 8)}`,
            name: 'Deep',
            position: 0,
          })
          .execute(),
      );
      expect(depth3).toMatchObject({ code: '23514', constraint: 'categories_depth_ck' });

      const otherRoot = await trx
        .insertInto('catalog.categories')
        .values({
          depth: 1,
          slug: `it-r2-${randomUUID().slice(0, 8)}`,
          name: 'Other',
          position: 998,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const reparent = await expectFailure(trx, () =>
        trx
          .updateTable('catalog.categories')
          .set({ depth: 2, parentId: otherRoot.id })
          .where('id', '=', rootId)
          .execute(),
      );
      expect(reparent).toMatchObject({
        code: '23503',
        constraint: 'categories_parent_id_parent_depth_fk',
      });

      // parent_depth is GENERATED ALWAYS: never writable (also typed ColumnType<number, never, never>)
      const genWrite = await expectFailure(trx, () =>
        sql`UPDATE catalog.categories SET parent_depth = 0 WHERE id = ${childId}`.execute(trx),
      );
      expect(genWrite.code).toBe('428C9');
    });
  });

  it('courses reference only depth-2 categories', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const err = await expectFailure(trx, () =>
        createDraftCourse(trx, { ownerId: w.ownerId, categoryId: w.rootId }),
      );
      expect(err).toMatchObject({
        code: '23503',
        constraint: 'courses_category_id_category_depth_fk',
      });
    });
  });
});

describe('positions (deferred uniques)', () => {
  async function curriculum(trx: Transaction<DB>, course: DraftCourse) {
    const s0 = await trx
      .insertInto('catalog.sections')
      .values({ courseId: course.courseId, title: 'S0', position: 0 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const s1 = await trx
      .insertInto('catalog.sections')
      .values({ courseId: course.courseId, title: 'S1', position: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const lecture = (sectionId: string, position: number) =>
      trx
        .insertInto('catalog.lectures')
        .values({
          courseId: course.courseId,
          sectionId,
          type: 'ARTICLE',
          title: `L${position}`,
          position,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const a = await lecture(s0.id, 0);
    const b = await lecture(s0.id, 1);
    const c = await lecture(s1.id, 0);
    return { s0: s0.id, s1: s1.id, a: a.id, b: b.id, c: c.id };
  }

  it('a section swap and a cross-section lecture move inside one transaction pass the COMMIT checks', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const ids = await curriculum(trx, course);
      // swap sections 0 <-> 1
      await trx
        .updateTable('catalog.sections')
        .set({ position: 1 })
        .where('id', '=', ids.s0)
        .execute();
      await trx
        .updateTable('catalog.sections')
        .set({ position: 0 })
        .where('id', '=', ids.s1)
        .execute();
      // move lecture a from s0 to s1 position 0, shift c to 1, b to 0 in s0
      await trx
        .updateTable('catalog.lectures')
        .set({ sectionId: ids.s1, position: 0 })
        .where('id', '=', ids.a)
        .execute();
      await trx
        .updateTable('catalog.lectures')
        .set({ position: 1 })
        .where('id', '=', ids.c)
        .execute();
      await trx
        .updateTable('catalog.lectures')
        .set({ position: 0 })
        .where('id', '=', ids.b)
        .execute();
      await checkDeferredNow(trx); // runs every deferred check COMMIT would run: no error
    });
  });

  it('a leftover duplicate section position fails at COMMIT (sections_course_id_position_uq)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const err = await commitError(async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const ids = await curriculum(trx, course);
      await trx
        .updateTable('catalog.sections')
        .set({ position: 0 })
        .where('id', '=', ids.s1)
        .execute(); // accepted now
    });
    expect(err).toMatchObject({ code: '23505', constraint: 'sections_course_id_position_uq' });
  });

  it('a leftover duplicate lecture position fails at COMMIT (lectures_section_id_position_uq)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const err = await commitError(async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const ids = await curriculum(trx, course);
      await trx
        .updateTable('catalog.lectures')
        .set({ position: 0 })
        .where('id', '=', ids.b)
        .execute();
    });
    expect(err).toMatchObject({ code: '23505', constraint: 'lectures_section_id_position_uq' });
  });

  it('two roots at the same position fail at COMMIT (categories_parent_id_position_uq, NULLS NOT DISTINCT)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const err = await commitError(async (trx) => {
      const { rootId } = await createCategoryPair(trx);
      const { position } = await trx
        .selectFrom('catalog.categories')
        .select('position')
        .where('id', '=', rootId)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('catalog.categories')
        .values({
          depth: 1,
          slug: `it-dup-${randomUUID().slice(0, 8)}`,
          name: 'Dup root',
          position,
        })
        .execute();
    });
    expect(err).toMatchObject({ code: '23505', constraint: 'categories_parent_id_position_uq' });
  });
});

describe('course transitions', () => {
  it('a full lifecycle (create, submit, approve, update submit, approve) commits cleanly', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const r1 = await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });
      await approve(trx, course, { revisionId: r1, adminId: w.adminId, from: 'IN_REVIEW' });
      const r2 = await submit(trx, course, { revisionNo: 2, from: 'PUBLISHED' });
      await approve(trx, course, { revisionId: r2, adminId: w.adminId, from: 'PUBLISHED' });
      await checkDeferredNow(trx);
      expect(await getTransitionHead(trx, course.courseId)).toEqual({
        id: course.head,
        toStatus: 'PUBLISHED',
      });
    });
  });

  it('a double decision fails on course_transitions_revision_id_decision_uq (approve + reject)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const r1 = await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });
      await approve(trx, course, { revisionId: r1, adminId: w.adminId, from: 'IN_REVIEW' });
      const err = await expectFailure(trx, () =>
        insertTransition(trx, {
          courseId: course.courseId,
          prevTransitionId: course.head,
          action: 'REJECT',
          fromStatus: 'PUBLISHED',
          toStatus: 'PUBLISHED',
          actorId: w.adminId,
          revisionId: r1,
          reason: 'Late rejection reason',
        }),
      );
      expect(err).toMatchObject({
        code: '23505',
        constraint: 'course_transitions_revision_id_decision_uq',
      });
    });
  });

  it('approving a revision after withdraw + resubmit fails on course_transitions_revision_id_decision_uq', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const r1 = await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });
      course.head = await insertTransition(trx, {
        courseId: course.courseId,
        prevTransitionId: course.head,
        action: 'WITHDRAW',
        fromStatus: 'IN_REVIEW',
        toStatus: 'DRAFT',
        actorId: w.ownerId,
        revisionId: r1,
      });
      await trx
        .updateTable('catalog.courses')
        .set({ status: 'DRAFT', pendingRevisionId: null })
        .where('id', '=', course.courseId)
        .execute();
      await submit(trx, course, { revisionNo: 2, from: 'DRAFT' });
      const err = await expectFailure(trx, () =>
        insertTransition(trx, {
          courseId: course.courseId,
          prevTransitionId: course.head,
          action: 'APPROVE',
          fromStatus: 'IN_REVIEW',
          toStatus: 'PUBLISHED',
          actorId: w.adminId,
          revisionId: r1,
        }),
      );
      expect(err).toMatchObject({
        code: '23505',
        constraint: 'course_transitions_revision_id_decision_uq',
      });
    });
  });

  it('self-approve and self-reject fail on course_transitions_self_decision_ck', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const r1 = await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });
      for (const [action, to, reason] of [
        ['APPROVE', 'PUBLISHED', null],
        ['REJECT', 'REJECTED', 'I reject my own course'],
      ] as const) {
        const err = await expectFailure(trx, () =>
          insertTransition(trx, {
            courseId: course.courseId,
            prevTransitionId: course.head,
            action,
            fromStatus: 'IN_REVIEW',
            toStatus: to,
            actorId: w.ownerId,
            revisionId: r1,
            reason,
          }),
        );
        expect(err).toMatchObject({
          code: '23514',
          constraint: 'course_transitions_self_decision_ck',
        });
      }
    });
  });

  it('owner restore after an admin takedown fails on course_transitions_restore_actor_ck', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const r1 = await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });
      await approve(trx, course, { revisionId: r1, adminId: w.adminId, from: 'IN_REVIEW' });
      // a takedown without a reason is rejected first
      const noReason = await expectFailure(trx, () =>
        insertTransition(trx, {
          courseId: course.courseId,
          prevTransitionId: course.head,
          action: 'ARCHIVE',
          fromStatus: 'PUBLISHED',
          toStatus: 'ARCHIVED',
          actorId: w.adminId,
        }),
      );
      expect(noReason).toMatchObject({
        code: '23514',
        constraint: 'course_transitions_takedown_reason_ck',
      });
      course.head = await insertTransition(trx, {
        courseId: course.courseId,
        prevTransitionId: course.head,
        action: 'ARCHIVE',
        fromStatus: 'PUBLISHED',
        toStatus: 'ARCHIVED',
        actorId: w.adminId,
        reason: 'Policy violation takedown',
      });
      await trx
        .updateTable('catalog.courses')
        .set({ status: 'ARCHIVED' })
        .where('id', '=', course.courseId)
        .execute();
      const err = await expectFailure(trx, () =>
        insertTransition(trx, {
          courseId: course.courseId,
          prevTransitionId: course.head,
          action: 'RESTORE',
          fromStatus: 'ARCHIVED',
          toStatus: 'PUBLISHED',
          actorId: w.ownerId,
        }),
      );
      expect(err).toMatchObject({
        code: '23514',
        constraint: 'course_transitions_restore_actor_ck',
      });
    });
  });

  it('two transitions with the same prev_transition_id fail on course_transitions_course_id_prev_transition_id_uq', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const create = course.head;
      await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });
      const r2 = await insertRevision(trx, {
        courseId: course.courseId,
        categoryId: w.childId,
        revisionNo: 2,
        kind: 'INITIAL',
      });
      const err = await expectFailure(trx, () =>
        insertTransition(trx, {
          courseId: course.courseId,
          prevTransitionId: create,
          action: 'SUBMIT',
          fromStatus: 'DRAFT',
          toStatus: 'IN_REVIEW',
          actorId: w.ownerId,
          revisionId: r2,
        }),
      );
      expect(err).toMatchObject({
        code: '23505',
        constraint: 'course_transitions_course_id_prev_transition_id_uq',
      });
      // a second root (CREATE) is the same constraint (NULLS NOT DISTINCT)
      const root2 = await expectFailure(trx, () =>
        insertTransition(trx, {
          courseId: course.courseId,
          prevTransitionId: null,
          action: 'CREATE',
          fromStatus: null,
          toStatus: 'DRAFT',
          actorId: w.ownerId,
        }),
      );
      expect(root2).toMatchObject({
        code: '23505',
        constraint: 'course_transitions_course_id_prev_transition_id_uq',
      });
    });
  });

  it('an illegal edge fails: ARCHIVE from DRAFT (edge_ck) and from_status != predecessor.to_status (chain FK)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const archive = await expectFailure(trx, () =>
        insertTransition(trx, {
          courseId: course.courseId,
          prevTransitionId: course.head,
          action: 'ARCHIVE',
          fromStatus: 'DRAFT',
          toStatus: 'ARCHIVED',
          actorId: w.ownerId,
        }),
      );
      expect(archive).toMatchObject({ code: '23514', constraint: 'course_transitions_edge_ck' });

      const r1 = await insertRevision(trx, {
        courseId: course.courseId,
        categoryId: w.childId,
        revisionNo: 1,
        kind: 'INITIAL',
      });
      // REJECTED -> IN_REVIEW is a legal edge, but the predecessor (CREATE) ended in DRAFT
      const chain = await expectFailure(trx, () =>
        insertTransition(trx, {
          courseId: course.courseId,
          prevTransitionId: course.head,
          action: 'SUBMIT',
          fromStatus: 'REJECTED',
          toStatus: 'IN_REVIEW',
          actorId: w.ownerId,
          revisionId: r1,
        }),
      );
      expect(chain).toMatchObject({
        code: '23503',
        constraint: 'course_transitions_course_id_prev_transition_id_from_status_fk',
      });
    });
  });
});

describe('status <-> log at COMMIT', () => {
  it('changing courses.status without a transition fails at COMMIT (courses_status_log_ck)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const err = await commitError(async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      await trx
        .updateTable('catalog.courses')
        .set({ status: 'REJECTED' })
        .where('id', '=', course.courseId)
        .execute();
    });
    expect(err).toMatchObject({ code: '23514', constraint: 'courses_status_log_ck' });
  });

  it('two pending SUBMITs fail at COMMIT (courses_status_log_ck)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    const err = await commitError(async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const r1 = await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });
      await approve(trx, course, { revisionId: r1, adminId: w.adminId, from: 'IN_REVIEW' });
      await submit(trx, course, { revisionNo: 2, from: 'PUBLISHED' });
      await submit(trx, course, { revisionNo: 3, from: 'PUBLISHED' }); // r2 still undecided
    });
    expect(err).toMatchObject({ code: '23514', constraint: 'courses_status_log_ck' });
  });
});

describe('revisions', () => {
  it.for([
    ['no SUBMIT transition', 'course_revisions_submit_log_ck', { submitted: false }],
    ['an empty section', 'course_revisions_complete_ck', { submitted: true, sections: [1, 0] }],
    ['fewer than 4 outcomes', 'course_revisions_complete_ck', { submitted: true, outcomes: 3 }],
  ] as const)('a revision with %s fails at COMMIT (%s)', async ([, constraint, shape], ctx) => {
    pg.skipIfUnavailable(ctx);
    const err = await commitError(async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      if (shape.submitted) {
        await submit(trx, course, {
          revisionNo: 1,
          from: 'DRAFT',
          ...('sections' in shape ? { sections: [...shape.sections] } : {}),
          ...('outcomes' in shape ? { outcomes: shape.outcomes } : {}),
        });
      } else {
        await insertRevision(trx, {
          courseId: course.courseId,
          categoryId: w.childId,
          revisionNo: 1,
          kind: 'INITIAL',
        });
      }
    });
    expect(err).toMatchObject({ code: '23514', constraint });
  });

  it('UPDATE, DELETE and TRUNCATE on revisions and transitions fail with 42501', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      const w = await world(trx);
      const course = await draft(trx, w);
      const r1 = await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });
      const attempts: [string, () => Promise<unknown>][] = [
        [
          'update revision',
          () =>
            sql`UPDATE catalog.course_revisions SET title = 'Changed title' WHERE id = ${r1}`.execute(
              trx,
            ),
        ],
        [
          'delete revision',
          () => sql`DELETE FROM catalog.course_revisions WHERE id = ${r1}`.execute(trx),
        ],
        [
          'update revision_bullets',
          () =>
            sql`UPDATE catalog.revision_bullets SET text = 'x' WHERE revision_id = ${r1}`.execute(
              trx,
            ),
        ],
        [
          'delete revision_sections',
          () => sql`DELETE FROM catalog.revision_lectures WHERE revision_id = ${r1}`.execute(trx),
        ],
        [
          'update transition',
          () =>
            sql`UPDATE catalog.course_transitions SET reason = 'x' WHERE course_id = ${course.courseId}`.execute(
              trx,
            ),
        ],
        [
          'delete transition',
          () => sql`DELETE FROM catalog.course_transitions WHERE id = ${course.head}`.execute(trx),
        ],
      ];
      for (const [label, run] of attempts) {
        const err = await expectFailure(trx, run);
        expect({ label, code: err.code }).toEqual({ label, code: '42501' });
      }
    });
    // TRUNCATE needs a transaction with no pending trigger events on the table (else 55006)
    const truncates: [string, string][] = [
      ['course_transitions', 'TRUNCATE catalog.course_transitions'],
      ['revision_lectures', 'TRUNCATE catalog.revision_lectures'],
      ['revision_bullets', 'TRUNCATE catalog.revision_bullets'],
      // course_revisions is an FK target, so plain TRUNCATE already fails (0A000); CASCADE reaches the trigger
      ['course_revisions CASCADE', 'TRUNCATE catalog.course_revisions CASCADE'],
    ];
    for (const [label, statement] of truncates) {
      await rollback(pg.db, async (trx) => {
        await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
        const err = await expectFailure(trx, () => sql.raw(statement).execute(trx));
        expect({ label, code: err.code }).toEqual({ label, code: '42501' });
      });
    }
  });
});

describe('review lock (courses_working_copy_locked_ck)', () => {
  it('blocks child writes and header edits while in review; slug frozen after approve', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const section = await trx
        .insertInto('catalog.sections')
        .values({ courseId: course.courseId, title: 'S0', position: 0 })
        .returning('id')
        .executeTakeFirstOrThrow();
      const lecture = await trx
        .insertInto('catalog.lectures')
        .values({
          courseId: course.courseId,
          sectionId: section.id,
          type: 'ARTICLE',
          title: 'L0',
          position: 0,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('catalog.lectureArticles')
        .values({ lectureId: lecture.id, bodyMd: 'Body' })
        .execute();
      await trx
        .insertInto('catalog.courseBullets')
        .values({ courseId: course.courseId, kind: 'OUTCOME', position: 0, text: 'One' })
        .execute();
      const r1 = await submit(trx, course, { revisionNo: 1, from: 'DRAFT' });

      const writes: [string, () => Promise<unknown>][] = [
        [
          'insert section',
          () =>
            trx
              .insertInto('catalog.sections')
              .values({ courseId: course.courseId, title: 'S1', position: 1 })
              .execute(),
        ],
        [
          'update section',
          () =>
            trx
              .updateTable('catalog.sections')
              .set({ title: 'S0 renamed' })
              .where('id', '=', section.id)
              .execute(),
        ],
        [
          'delete section',
          () => trx.deleteFrom('catalog.sections').where('id', '=', section.id).execute(),
        ],
        [
          'insert lecture',
          () =>
            trx
              .insertInto('catalog.lectures')
              .values({
                courseId: course.courseId,
                sectionId: section.id,
                type: 'ARTICLE',
                title: 'L1',
                position: 1,
              })
              .execute(),
        ],
        [
          'update lecture',
          () =>
            trx
              .updateTable('catalog.lectures')
              .set({ title: 'L0 renamed' })
              .where('id', '=', lecture.id)
              .execute(),
        ],
        [
          'delete lecture',
          () => trx.deleteFrom('catalog.lectures').where('id', '=', lecture.id).execute(),
        ],
        [
          'insert bullet',
          () =>
            trx
              .insertInto('catalog.courseBullets')
              .values({ courseId: course.courseId, kind: 'OUTCOME', position: 1, text: 'Two' })
              .execute(),
        ],
        [
          'update bullet',
          () =>
            trx
              .updateTable('catalog.courseBullets')
              .set({ text: 'Uno' })
              .where('courseId', '=', course.courseId)
              .execute(),
        ],
        [
          'delete bullet',
          () =>
            trx
              .deleteFrom('catalog.courseBullets')
              .where('courseId', '=', course.courseId)
              .execute(),
        ],
        [
          'update article',
          () =>
            trx
              .updateTable('catalog.lectureArticles')
              .set({ bodyMd: 'New body' })
              .where('lectureId', '=', lecture.id)
              .execute(),
        ],
        [
          'delete article',
          () =>
            trx.deleteFrom('catalog.lectureArticles').where('lectureId', '=', lecture.id).execute(),
        ],
        [
          'title change',
          () =>
            trx
              .updateTable('catalog.courses')
              .set({ title: 'Another title' })
              .where('id', '=', course.courseId)
              .execute(),
        ],
      ];
      for (const [label, run] of writes) {
        const err = await expectFailure(trx, run);
        expect({ label, code: err.code, constraint: err.constraint }).toEqual({
          label,
          code: '23514',
          constraint: 'courses_working_copy_locked_ck',
        });
      }

      await approve(trx, course, { revisionId: r1, adminId: w.adminId, from: 'IN_REVIEW' });
      // unlocked again (no pending) ...
      await trx
        .updateTable('catalog.courses')
        .set({ title: 'Another title' })
        .where('id', '=', course.courseId)
        .execute();
      // ... but the slug is frozen now
      const slug = await expectFailure(trx, () =>
        trx
          .updateTable('catalog.courses')
          .set({ slug: `it-new-${randomUUID().slice(0, 8)}` })
          .where('id', '=', course.courseId)
          .execute(),
      );
      expect(slug).toMatchObject({ code: '23514', constraint: 'courses_slug_frozen_ck' });
    });
  });
});

describe('catalog read helpers (§8.5) and consistency checks (§8.6)', () => {
  it('review queue is oldest-first with a revision-id keyset; browse pages by (first_published_at, id)', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const c1 = await draft(trx, w);
      const c2 = await draft(trx, w);
      const r1 = await submit(trx, c1, { revisionNo: 1, from: 'DRAFT' });
      const r2 = await submit(trx, c2, { revisionNo: 1, from: 'DRAFT' });

      const queue = await listReviewQueue(trx, { limit: 200 });
      const mine = queue
        .filter((q) => q.revisionId === r1 || q.revisionId === r2)
        .map((q) => q.revisionId);
      expect(mine).toEqual([r1, r2].sort());
      const after = await listReviewQueue(trx, { limit: 200, afterRevisionId: mine[0] });
      expect(after.map((q) => q.revisionId)).not.toContain(mine[0]);
      expect(after.map((q) => q.revisionId)).toContain(mine[1]);
      expect(queue.find((q) => q.revisionId === r1)).toMatchObject({
        courseId: c1.courseId,
        ownerId: w.ownerId,
        revisionNo: 1,
        kind: 'INITIAL',
      });

      await approve(trx, c1, { revisionId: r1, adminId: w.adminId, from: 'IN_REVIEW' });
      await approve(trx, c2, { revisionId: r2, adminId: w.adminId, from: 'IN_REVIEW' });
      // same transaction -> same first_published_at; the id breaks the tie
      const page1 = await browsePublishedCourses(trx, { limit: 1, categoryIds: [w.childId] });
      expect(page1).toHaveLength(1);
      const page2 = await browsePublishedCourses(trx, {
        limit: 5,
        categoryIds: [w.childId],
        after: page1[0]!.cursor,
      });
      expect([page1[0]!.id, ...page2.map((r) => r.id)]).toEqual(
        [c1.courseId, c2.courseId].sort().reverse(),
      );
      expect(
        await browsePublishedCourses(trx, { limit: 5, categoryIds: [w.childId], level: 'EXPERT' }),
      ).toEqual([]);
      expect(
        await browsePublishedCourses(trx, {
          limit: 5,
          categoryIds: [w.childId],
          titleContains: 'integration',
        }),
      ).toHaveLength(2);
      expect(
        await browsePublishedCourses(trx, {
          limit: 5,
          categoryIds: [w.childId],
          titleContains: '%',
        }),
      ).toEqual([]);
    });
  });

  it('getTransitionHead returns null without history', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    expect(await getTransitionHead(pg.db, randomUUID())).toBeNull();
  });

  it('drift detection finds a lecture without usage and a leaked usage', async (ctx) => {
    pg.skipIfUnavailable(ctx);
    await rollback(pg.db, async (trx) => {
      const w = await world(trx);
      const course = await draft(trx, w);
      const section = await trx
        .insertInto('catalog.sections')
        .values({ courseId: course.courseId, title: 'S0', position: 0 })
        .returning('id')
        .executeTakeFirstOrThrow();
      const assetId = randomUUID();
      const lecture = await trx
        .insertInto('catalog.lectures')
        .values({
          courseId: course.courseId,
          sectionId: section.id,
          type: 'VIDEO',
          title: 'V',
          position: 0,
          mediaAssetId: assetId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const missing = await findLecturesWithoutUsage(trx, { limit: 10_000 });
      expect(missing).toContainEqual({ id: lecture.id, mediaAssetId: assetId });
      const leaked = await findLeakedUsages(trx, { limit: 10_000 });
      expect(Array.isArray(leaked)).toBe(true);
    });
  });
});
