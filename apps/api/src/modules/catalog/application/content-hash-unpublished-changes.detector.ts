import { Injectable } from '@nestjs/common';
import type { Executor } from '@udemy/db';
import { contentHash } from '../domain/revision-snapshot';
import type { CourseRecord } from './ports/course.repository';
import { RevisionRepository } from './ports/revision.repository';
import { UnpublishedChangesDetector } from './ports/unpublished-changes.detector';
import { WorkingCopySnapshotter } from './working-copy-snapshotter';

/**
 * "Unpublished changes" (design §4): the working copy's content hash differs from the live
 * revision's `content_hash`. A never-published course has nothing to compare with (false).
 * The same canonical hash decides `nothing_to_review` at submit, so the badge and the submit
 * button can never disagree.
 */
@Injectable()
export class ContentHashUnpublishedChangesDetector extends UnpublishedChangesDetector {
  constructor(
    private readonly snapshotter: WorkingCopySnapshotter,
    private readonly revisions: RevisionRepository,
  ) {
    super();
  }

  async hasUnpublishedChanges(course: CourseRecord, ex?: Executor): Promise<boolean> {
    if (course.publishedRevisionId === null) return false;
    const live = await this.revisions.findContentHashHex(course.publishedRevisionId, ex);
    if (live === null) return true;
    const working = contentHash(await this.snapshotter.content(course, ex)).toString('hex');
    return working !== live;
  }
}
