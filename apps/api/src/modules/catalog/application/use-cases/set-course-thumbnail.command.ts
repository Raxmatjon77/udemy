import { Injectable } from '@nestjs/common';
import type { CourseDetail } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface SetCourseThumbnailInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly assetId: string;
}

/** The thumbnail usage of a course: consumer `catalog.course_thumbnail`, id = courseId. */
export function thumbnailConsumer(courseId: string): {
  readonly type: 'catalog.course_thumbnail';
  readonly id: string;
} {
  return { type: 'catalog.course_thumbnail', id: courseId };
}

/**
 * `SetCourseThumbnail` (design §5): under the course lock, RELEASE the previous thumbnail's
 * usage, then USE the new COURSE_THUMBNAIL asset (schema doc §6 item 12: release-then-use, or
 * `asset_usages_consumer_working_uq` would see two rows), then point the course at it.
 * Re-setting the current thumbnail is a no-op.
 *
 * Errors from MediaFacade: 404 `media_asset_not_found` (also another user's asset), 422
 * `media_purpose_mismatch`, 409 `media_asset_unusable` (failed, aborted, purged, or used
 * by another course). Any error rolls the release back too.
 */
@Injectable()
export class SetCourseThumbnailCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly media: MediaFacade,
    private readonly locker: CourseLocker,
    private readonly detail: CourseDetailAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: SetCourseThumbnailInput): Promise<CourseDetail> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      if (course.thumbnailAssetId === input.assetId) return this.detail.build(course, trx);

      const consumer = thumbnailConsumer(course.id);
      if (course.thumbnailAssetId !== null) {
        await this.media.releaseAsset(trx, { assetId: course.thumbnailAssetId, consumer });
      }
      await this.media.useAsset(trx, {
        assetId: input.assetId,
        ownerId: course.ownerId,
        purpose: 'COURSE_THUMBNAIL',
        consumer,
      });
      const updated = await this.courses.updateHeader(trx, course.id, {
        thumbnailAssetId: input.assetId,
      });
      return this.detail.build(updated, trx);
    });
  }
}
