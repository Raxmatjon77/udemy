import { Injectable } from '@nestjs/common';
import type { Lecture, LectureType } from '@udemy/contracts';
import { SectionNotFound } from '../../domain/catalog.errors';
import { assertCanAddLecture } from '../../domain/curriculum';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toLectureView } from '../views';

export interface AddLectureInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly sectionId: string;
  readonly type: LectureType;
  readonly title: string;
}

/**
 * `AddLecture` (design §5): appended at the end of a section of THIS course (another course's
 * section is 404 `section_not_found`); ≤ 100 per section and ≤ 500 per course. The type is
 * immutable afterwards.
 */
@Injectable()
export class AddLectureCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: AddLectureInput): Promise<Lecture> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const section = await this.curriculum.findSection(course.id, input.sectionId, trx);
      if (section === null) throw new SectionNotFound();
      const counts = await this.curriculum.countLectures(trx, course.id, section.id);
      assertCanAddLecture(counts);
      const lecture = await this.curriculum.insertLecture(trx, {
        courseId: course.id,
        sectionId: section.id,
        type: input.type,
        title: input.title,
        position: counts.inSection,
      });
      await this.courses.bumpVersion(trx, course.id);
      return toLectureView(lecture, null, lecture.type === 'ARTICLE' ? 0 : null);
    });
  }
}
