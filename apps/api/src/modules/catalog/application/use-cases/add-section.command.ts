import { Injectable } from '@nestjs/common';
import type { Section } from '@udemy/contracts';
import { assertCanAddSection } from '../../domain/curriculum';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toSectionView } from '../views';

export interface AddSectionInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly title: string;
  readonly objective?: string;
}

/** `AddSection` (design §5): appended at the end; ≤ 50 per course (422 `curriculum_limit_exceeded`). */
@Injectable()
export class AddSectionCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: AddSectionInput): Promise<Section> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const count = await this.curriculum.countSections(trx, course.id);
      assertCanAddSection(count);
      const section = await this.curriculum.insertSection(trx, {
        courseId: course.id,
        title: input.title,
        objective: input.objective ?? null,
        position: count,
      });
      await this.courses.bumpVersion(trx, course.id);
      return toSectionView(section);
    });
  }
}
