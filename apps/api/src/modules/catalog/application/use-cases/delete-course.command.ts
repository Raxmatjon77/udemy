import { Injectable } from '@nestjs/common';
import { type AssetConsumer, MediaFacade } from '../../../media';
import { assertDeletable } from '../../domain/course';
import { CourseNotFound, InvalidStateTransition } from '../../domain/catalog.errors';
import { CourseLocker } from '../course-locker';
import { CatalogEventPublisher } from '../ports/catalog-event.publisher';
import { CourseLifecycleRepository } from '../ports/course-lifecycle.repository';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { thumbnailConsumer } from './set-course-thumbnail.command';

export interface DeleteCourseInput {
  readonly actorId: string;
  readonly courseId: string;
}

/**
 * `DeleteCourse` (design §5, D13): soft-deletes a never-published course in one transaction.
 *
 * 1. Lock the course; only its owner, never published (409 `course_published_cannot_delete`,
 *    archive instead), no pending revision (409 `course_in_review`).
 * 2. Release every working-copy media usage through `MediaFacade.releaseConsumer` (lecture
 *    media and the thumbnail, ascending asset id) and NULL the references (schema doc §6
 *    item 6: otherwise `lectures_media_asset_id_uq` would block re-attaching the assets;
 *    `courses_deleted_at_ck` requires the thumbnail to be NULL).
 * 3. Append the DELETE transition and set `deleted_at` (same `now()`, verified at COMMIT by
 *    `courses_status_log_ck`), and emit `CourseDeleted`.
 *
 * Children are kept (history); the deleted course is invisible everywhere afterwards.
 */
@Injectable()
export class DeleteCourseCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly media: MediaFacade,
    private readonly events: CatalogEventPublisher,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: DeleteCourseInput): Promise<void> {
    await this.tx.run(async (trx) => {
      const course = await this.locker.lock(trx, input.courseId);
      if (course.ownerId !== input.actorId) throw new CourseNotFound();
      assertDeletable(course);

      // Release in ascending asset order (lock order: course -> assets ascending).
      const releases: { assetId: string; consumer: AssetConsumer }[] = (
        await this.curriculum.listLectureMedia(trx, course.id)
      ).map((ref) => ({
        assetId: ref.assetId,
        consumer: { type: 'catalog.lecture', id: ref.lectureId },
      }));
      if (course.thumbnailAssetId !== null) {
        releases.push({ assetId: course.thumbnailAssetId, consumer: thumbnailConsumer(course.id) });
      }
      releases.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
      for (const release of releases) await this.media.releaseConsumer(trx, release.consumer);

      if (releases.length > 0) await this.curriculum.clearAllLectureMedia(trx, course.id);
      if (course.thumbnailAssetId !== null) {
        await this.courses.updateHeader(trx, course.id, { thumbnailAssetId: null });
      }

      const head = await this.lifecycle.getTransitionHead(trx, course.id);
      if (head === null || head.toStatus !== course.status) throw new InvalidStateTransition();
      await this.lifecycle.appendTransition(trx, {
        courseId: course.id,
        prevTransitionId: head.id,
        revisionId: null,
        action: 'DELETE',
        fromStatus: course.status,
        toStatus: course.status,
        actorId: input.actorId,
        reason: null,
      });
      const deletedAt = await this.courses.markDeleted(trx, course.id);
      await this.events.courseDeleted(trx, {
        courseId: course.id,
        ownerId: course.ownerId,
        deletedAt: deletedAt.toISOString(),
      });
    });
  }
}
