import { Injectable } from '@nestjs/common';
import { MediaFacade } from '../../../media';
import { LectureNotFound } from '../../domain/catalog.errors';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface DeleteLectureInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
}

/**
 * `DeleteLecture` (design §5): releases its media usage, deletes it (the article cascades) and
 * compacts the positions of its section, in one transaction.
 */
@Injectable()
export class DeleteLectureCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly media: MediaFacade,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: DeleteLectureInput): Promise<void> {
    await this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await this.curriculum.findLecture(course.id, input.lectureId, trx);
      if (lecture === null) throw new LectureNotFound();
      if (lecture.mediaAssetId !== null) {
        await this.media.releaseConsumer(trx, { type: 'catalog.lecture', id: lecture.id });
      }
      await this.curriculum.deleteLecture(trx, course.id, lecture.id);
      await this.courses.bumpVersion(trx, course.id);
    });
  }
}
