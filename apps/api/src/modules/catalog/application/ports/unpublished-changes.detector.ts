import type { Executor } from '@udemy/db';
import type { CourseRecord } from './course.repository';

/**
 * `CourseDetail.hasUnpublishedChanges`: does the working copy differ from the live revision?
 * Bound to `ContentHashUnpublishedChangesDetector` (working-copy content hash vs the live
 * revision's `content_hash`, design §4).
 */
export abstract class UnpublishedChangesDetector {
  abstract hasUnpublishedChanges(course: CourseRecord, ex?: Executor): Promise<boolean>;
}
