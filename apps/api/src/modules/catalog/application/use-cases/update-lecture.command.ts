import { Injectable } from '@nestjs/common';
import type { Lecture } from '@udemy/contracts';
import { LectureNotFound } from '../../domain/catalog.errors';
import { assertCanBePreview } from '../../domain/curriculum';
import { assertMarkdownAllowed } from '../../domain/markdown';
import { CourseLocker } from '../course-locker';
import { CurriculumReader } from '../curriculum-reader';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository, type LecturePatch } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toLoadedLectureView } from '../views';

export interface UpdateLectureInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
  readonly patch: LecturePatch;
}

/**
 * `UpdateLecture` (design §5): title, description markdown (422 `markdown_not_allowed`) and
 * the free-preview flag (invariant 4: VIDEO/ARTICLE only, ≤ 10 per course, 422
 * `preview_not_allowed`; counted under the course lock).
 */
@Injectable()
export class UpdateLectureCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly reader: CurriculumReader,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: UpdateLectureInput): Promise<Lecture> {
    const description = input.patch.descriptionMd;
    if (description !== undefined && description !== null) {
      assertMarkdownAllowed('descriptionMd', description);
    }
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await this.curriculum.findLecture(course.id, input.lectureId, trx);
      if (lecture === null) throw new LectureNotFound();
      if (input.patch.isPreview === true && !lecture.isPreview) {
        assertCanBePreview(
          lecture.type,
          await this.curriculum.countPreviews(trx, course.id, lecture.id),
        );
      }
      const updated = await this.curriculum.updateLecture(trx, course.id, lecture.id, input.patch);
      await this.courses.bumpVersion(trx, course.id);
      return toLoadedLectureView(await this.reader.loadLecture(updated, trx));
    });
  }
}
