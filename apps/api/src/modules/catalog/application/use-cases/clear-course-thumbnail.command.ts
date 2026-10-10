import { Injectable } from '@nestjs/common';
import type { CourseDetail } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { thumbnailConsumer } from './set-course-thumbnail.command';

export interface ClearCourseThumbnailInput {
  readonly actorId: string;
  readonly courseId: string;
}

/**
 * `ClearCourseThumbnail` (design §5): releases the thumbnail usage (the asset becomes
 * purge-eligible after the grace period if nothing else uses it) and clears the pointer.
 * Idempotent: a course without a thumbnail answers its current state.
 */
@Injectable()
export class ClearCourseThumbnailCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly media: MediaFacade,
    private readonly locker: CourseLocker,
    private readonly detail: CourseDetailAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: ClearCourseThumbnailInput): Promise<CourseDetail> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      if (course.thumbnailAssetId === null) return this.detail.build(course, trx);

      await this.media.releaseAsset(trx, {
        assetId: course.thumbnailAssetId,
        consumer: thumbnailConsumer(course.id),
      });
      const updated = await this.courses.updateHeader(trx, course.id, { thumbnailAssetId: null });
      return this.detail.build(updated, trx);
    });
  }
}
