import type { DB, Transaction } from '@udemy/db';
import type { AssetConsumer } from '../../media';
import { InvalidStateTransition, RevisionNotFound } from '../domain/catalog.errors';
import type {
  CourseLifecycleRepository,
  RevisionSummaryRecord,
  TransitionHead,
} from './ports/course-lifecycle.repository';
import type { CourseRecord } from './ports/course.repository';

/**
 * The chain head, read under the course row lock: the next transition's `prev_transition_id`
 * (schema doc §6 item 13). Its `to_status` must equal the materialised status; a mismatch is
 * a corrupt log (`courses_status_log_ck` would reject the commit anyway).
 *
 * @throws InvalidStateTransition (409)
 */
export async function requireTransitionHead(
  lifecycle: CourseLifecycleRepository,
  trx: Transaction<DB>,
  course: CourseRecord,
): Promise<TransitionHead> {
  const head = await lifecycle.getTransitionHead(trx, course.id);
  if (head === null || head.toStatus !== course.status) throw new InvalidStateTransition();
  return head;
}

/** The media consumer that pins a revision's assets (design D8). */
export function revisionConsumer(revisionId: string): AssetConsumer {
  return { type: 'catalog.course_revision', id: revisionId };
}

/** The revision, which must belong to the course (a foreign or unknown id is 404). */
export async function requireRevisionOf(
  lifecycle: CourseLifecycleRepository,
  trx: Transaction<DB>,
  courseId: string,
  revisionId: string,
): Promise<RevisionSummaryRecord> {
  const [revision] = await lifecycle.findRevisionSummaries([revisionId], trx);
  if (revision === undefined || revision.courseId !== courseId) throw new RevisionNotFound();
  return revision;
}
