import { Injectable } from '@nestjs/common';
import type { Lecture } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { LectureNotFound } from '../../domain/catalog.errors';
import { mediaPurposeFor } from '../../domain/curriculum';
import { CourseLocker } from '../course-locker';
import { CurriculumReader } from '../curriculum-reader';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toLectureView, toLoadedLectureView } from '../views';

export interface AttachLectureMediaInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly assetId: string;
}

/**
 * `AttachLectureMedia` (design §5): attaches (or swaps) the lecture's video/resource. Under the
 * course lock: the purpose follows the lecture type (`LECTURE_MEDIA_PURPOSE`; ARTICLE is 422
 * `lecture_type_mismatch`), the previous asset is RELEASED first, then the new one is USED
 * (consumer `catalog.lecture` = lectureId; schema doc §6 item 12), then the lecture points at
 * it. Re-attaching the current asset is a no-op.
 *
 * MediaFacade errors: 404 `media_asset_not_found` (also another user's asset), 422
 * `media_purpose_mismatch`, 409 `media_asset_unusable` (failed/aborted/purged or attached to
 * another lecture). Any error rolls the release back.
 */
@Injectable()
export class AttachLectureMediaCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly reader: CurriculumReader,
    private readonly media: MediaFacade,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: AttachLectureMediaInput): Promise<Lecture> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await this.curriculum.findLecture(course.id, input.lectureId, trx);
      if (lecture === null) throw new LectureNotFound();
      const purpose = mediaPurposeFor(lecture.type);
      if (lecture.mediaAssetId === input.assetId) {
        return toLoadedLectureView(await this.reader.loadLecture(lecture, trx));
      }

      const consumer = { type: 'catalog.lecture' as const, id: lecture.id };
      if (lecture.mediaAssetId !== null) {
        await this.media.releaseAsset(trx, { assetId: lecture.mediaAssetId, consumer });
      }
      const asset = await this.media.useAsset(trx, {
        assetId: input.assetId,
        ownerId: course.ownerId,
        purpose,
        consumer,
      });
      const updated = await this.curriculum.setLectureMedia(
        trx,
        course.id,
        lecture.id,
        input.assetId,
      );
      await this.courses.bumpVersion(trx, course.id);
      return toLectureView(updated, asset, null);
    });
  }
}
