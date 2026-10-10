import { Injectable } from '@nestjs/common';
import type { Executor } from '@udemy/db';
import type { CourseRecord } from './course.repository';

/**
 * `CourseDetail.hasUnpublishedChanges`: does the working copy differ from the live revision?
 *
 * The real answer compares the working-copy content hash with the live revision's
 * `content_hash` (design §4); the snapshot/hash builder lands with P2-T10, which rebinds this
 * port. Until then `LiveRevisionPresenceDetector` answers conservatively.
 */
export abstract class UnpublishedChangesDetector {
  abstract hasUnpublishedChanges(course: CourseRecord, ex?: Executor): Promise<boolean>;
}

/**
 * P2-T9 default: a never-published course has nothing to compare with (false); a published
 * one is reported as changed (true) until P2-T10 provides the hash comparison.
 */
@Injectable()
export class LiveRevisionPresenceDetector extends UnpublishedChangesDetector {
  hasUnpublishedChanges(course: CourseRecord): Promise<boolean> {
    return Promise.resolve(course.publishedRevisionId !== null);
  }
}
