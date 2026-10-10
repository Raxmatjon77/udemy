import { Injectable } from '@nestjs/common';
import { REVISION_KINDS } from '@udemy/contracts';
import { type DB, type Executor, getTransitionHead, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  CourseLifecycleRepository,
  type DecisionRecord,
  type NewTransition,
  type RevisionSummaryRecord,
  type TransitionHead,
} from '../application/ports/course-lifecycle.repository';
import { mapCatalogConstraints } from './catalog-constraint-errors';
import { toCourseStatus } from './kysely-course.repository';
import { narrow } from './row-mapping';

/** `catalog.course_transitions` (hash-linked chain) and revision summaries with Kysely. */
@Injectable()
export class KyselyCourseLifecycleRepository extends CourseLifecycleRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async getTransitionHead(trx: Transaction<DB>, courseId: string): Promise<TransitionHead | null> {
    const head = await getTransitionHead(trx, courseId);
    return head === null ? null : { id: head.id, toStatus: toCourseStatus(head.toStatus) };
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
      .select(['id', 'revisionNo', 'kind', 'submittedAt'])
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
}
