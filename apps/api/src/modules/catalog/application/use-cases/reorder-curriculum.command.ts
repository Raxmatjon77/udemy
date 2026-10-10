import { Injectable } from '@nestjs/common';
import type { Curriculum } from '@udemy/contracts';
import { CourseNotFound } from '../../domain/catalog.errors';
import { planCurriculumOrder, type RequestedSectionOrder } from '../../domain/curriculum';
import { CourseLocker } from '../course-locker';
import { CurriculumReader } from '../curriculum-reader';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toCurriculumView } from '../views';

export interface ReorderCurriculumInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly sections: readonly RequestedSectionOrder[];
}

/**
 * `ReorderCurriculum` (design D3): the client sends the WHOLE order
 * `[{sectionId, lectureIds[]}]`. Under the course lock it must be exactly a permutation of the
 * current sections and lectures (lectures may change section), otherwise 409
 * `order_mismatch` (a stale tab refetches instead of corrupting the order). Every position is
 * rewritten in one transaction; the position uniques are DEFERRED, so intermediate duplicates
 * are fine and only the committed order is checked.
 */
@Injectable()
export class ReorderCurriculumCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly reader: CurriculumReader,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: ReorderCurriculumInput): Promise<Curriculum> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const sections = await this.curriculum.listSections(course.id, trx);
      const lectures = await this.curriculum.listLectures(course.id, trx);
      const positions = planCurriculumOrder(
        { sectionIds: sections.map((s) => s.id), lectureIds: lectures.map((l) => l.id) },
        input.sections,
      );
      await this.curriculum.applyPositions(trx, course.id, positions);
      await this.courses.bumpVersion(trx, course.id);
      const updated = await this.courses.findById(course.id, trx);
      if (updated === null) throw new CourseNotFound();
      return toCurriculumView(updated, await this.reader.load(updated, trx));
    });
  }
}
