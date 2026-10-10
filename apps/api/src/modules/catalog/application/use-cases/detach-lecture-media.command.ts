import { Injectable } from '@nestjs/common';
import type { Lecture } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { LectureNotFound } from '../../domain/catalog.errors';
import { CourseLocker } from '../course-locker';
import { CurriculumReader } from '../curriculum-reader';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toLectureView, toLoadedLectureView } from '../views';

export interface DetachLectureMediaInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
}

/**
 * `DetachLectureMedia` (design §5): releases the usage and clears `media_asset_id`.
 * Idempotent: a lecture without media answers its current state.
 */
@Injectable()
export class DetachLectureMediaCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly reader: CurriculumReader,
    private readonly media: MediaFacade,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: DetachLectureMediaInput): Promise<Lecture> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await this.curriculum.findLecture(course.id, input.lectureId, trx);
      if (lecture === null) throw new LectureNotFound();
      if (lecture.mediaAssetId === null) {
        return toLoadedLectureView(await this.reader.loadLecture(lecture, trx));
      }
      await this.media.releaseAsset(trx, {
        assetId: lecture.mediaAssetId,
        consumer: { type: 'catalog.lecture', id: lecture.id },
      });
      const updated = await this.curriculum.setLectureMedia(trx, course.id, lecture.id, null);
      await this.courses.bumpVersion(trx, course.id);
      return toLectureView(updated, null, null);
    });
  }
}
