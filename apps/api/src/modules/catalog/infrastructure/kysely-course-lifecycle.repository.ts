import { Injectable } from '@nestjs/common';
import {
  COURSE_STATUSES,
  COURSE_TRANSITION_ACTIONS,
  type CourseTransitionAction,
  REVISION_KINDS,
} from '@udemy/contracts';
import {
  type DB,
  type Executor,
  getTransitionHead,
  listReviewQueue,
  type Transaction,
} from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  CourseLifecycleRepository,
  type DecisionRecord,
  type NewTransition,
  type ReviewQueueRecord,
  type RevisionSummaryRecord,
  type TransitionHead,
  type TransitionRecord,
} from '../application/ports/course-lifecycle.repository';
import { mapCatalogConstraints } from './catalog-constraint-errors';
import { toCourseStatus } from './kysely-course.repository';
import { narrow, narrowNullable } from './row-mapping';

const toAction = (value: string): CourseTransitionAction =>
  narrow(COURSE_TRANSITION_ACTIONS, value, 'catalog.course_transitions.action');

/** `catalog.course_transitions` (hash-linked chain) and revision summaries with Kysely. */
@Injectable()
export class KyselyCourseLifecycleRepository extends CourseLifecycleRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async getTransitionHead(trx: Transaction<DB>, courseId: string): Promise<TransitionHead | null> {
    const head = await getTransitionHead(trx, courseId);
    if (head === null) return null;
    const row = await trx
      .selectFrom('catalog.courseTransitions')
      .select(['action', 'actorId'])
      .where('id', '=', head.id)
      .executeTakeFirstOrThrow();
    return {
      id: head.id,
      toStatus: toCourseStatus(head.toStatus),
      action: toAction(row.action),
      actorId: row.actorId,
    };
  }

  async appendTransition(
    trx: Transaction<DB>,
    transition: NewTransition,
  ): Promise<{ id: string; occurredAt: Date }> {
    return mapCatalogConstraints(() =>
      trx
        .insertInto('catalog.courseTransitions')
        .values({
          courseId: transition.courseId,
          prevTransitionId: transition.prevTransitionId,
          revisionId: transition.revisionId,
          action: transition.action,
          fromStatus: transition.fromStatus,
          toStatus: transition.toStatus,
          actorId: transition.actorId,
          reason: transition.reason,
        })
        .returning(['id', 'occurredAt'])
        .executeTakeFirstOrThrow(),
    );
  }

  async findRevisionSummaries(
    revisionIds: readonly string[],
    ex: Executor = this.db,
  ): Promise<RevisionSummaryRecord[]> {
    const ids = [...new Set(revisionIds)];
    if (ids.length === 0) return [];
    const rows = await ex
      .selectFrom('catalog.courseRevisions')
      .select(['id', 'courseId', 'revisionNo', 'kind', 'submittedAt'])
      .where('id', 'in', ids)
      .execute();
    return rows.map((row) => ({
      ...row,
      kind: narrow(REVISION_KINDS, row.kind, 'catalog.course_revisions.kind'),
    }));
  }

  async findLatestDecision(
    courseId: string,
    ex: Executor = this.db,
  ): Promise<DecisionRecord | null> {
    const row = await ex
      .selectFrom('catalog.courseTransitions as t')
      .innerJoin('catalog.courseRevisions as r', 'r.id', 't.revisionId')
      .select(['t.action', 't.revisionId', 'r.revisionNo', 't.reason', 't.occurredAt'])
      .where('t.courseId', '=', courseId)
      .where('t.action', 'in', ['APPROVE', 'REJECT'])
      .orderBy('r.revisionNo', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined || row.revisionId === null) return null;
    return {
      action: narrow(['APPROVE', 'REJECT'] as const, row.action, 'course_transitions.action'),
      revisionId: row.revisionId,
      revisionNo: row.revisionNo,
      reason: row.reason,
      decidedAt: row.occurredAt,
    };
  }

  async findHeadAction(
    courseId: string,
    ex: Executor = this.db,
  ): Promise<CourseTransitionAction | null> {
    const row = await ex
      .selectFrom('catalog.courseTransitions as t')
      .select('t.action')
      .where('t.courseId', '=', courseId)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('catalog.courseTransitions as n')
              .select('n.id')
              .where('n.courseId', '=', courseId)
              .whereRef('n.prevTransitionId', '=', 't.id'),
          ),
        ),
      )
      .executeTakeFirst();
    return row === undefined ? null : toAction(row.action);
  }

  async listHistory(courseId: string, ex: Executor = this.db): Promise<TransitionRecord[]> {
    const rows = await ex
      .selectFrom('catalog.courseTransitions as t')
      .leftJoin('catalog.courseRevisions as r', 'r.id', 't.revisionId')
      .select([
        't.id',
        't.prevTransitionId',
        't.action',
        't.fromStatus',
        't.toStatus',
        't.revisionId',
        'r.revisionNo',
        't.actorId',
        't.reason',
        't.occurredAt',
      ])
      .where('t.courseId', '=', courseId)
      .execute();
    // The chain is linear (unique successor): walk it from the root instead of trusting clocks.
    const bySuccessorOf = new Map(rows.map((row) => [row.prevTransitionId, row]));
    const ordered: TransitionRecord[] = [];
    for (let row = bySuccessorOf.get(null); row !== undefined; row = bySuccessorOf.get(row.id)) {
      ordered.push({
        id: row.id,
        prevTransitionId: row.prevTransitionId,
        action: toAction(row.action),
        fromStatus: narrowNullable(
          COURSE_STATUSES,
          row.fromStatus,
          'course_transitions.from_status',
        ),
        toStatus: toCourseStatus(row.toStatus),
        revisionId: row.revisionId,
        revisionNo: row.revisionNo,
        actorId: row.actorId,
        reason: row.reason,
        occurredAt: row.occurredAt,
      });
      if (ordered.length > rows.length) throw new Error(`course ${courseId}: cyclic history`);
    }
    return ordered;
  }

  async listReviewQueue(query: {
    readonly limit: number;
    readonly afterRevisionId: string | null;
  }): Promise<ReviewQueueRecord[]> {
    const rows = await listReviewQueue(this.db, {
      limit: query.limit,
      ...(query.afterRevisionId === null ? {} : { afterRevisionId: query.afterRevisionId }),
    });
    return rows.map((row) => ({
      ...row,
      kind: narrow(REVISION_KINDS, row.kind, 'catalog.course_revisions.kind'),
    }));
  }
}
