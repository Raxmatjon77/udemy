import { Injectable } from '@nestjs/common';
import type { Section } from '@udemy/contracts';
import { SectionNotFound } from '../../domain/catalog.errors';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository, type SectionPatch } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toSectionView } from '../views';

export interface UpdateSectionInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly sectionId: string;
  readonly patch: SectionPatch;
}

/** `UpdateSection` (design §5): title/objective; the section must belong to the course (404). */
@Injectable()
export class UpdateSectionCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  execute(input: UpdateSectionInput): Promise<Section> {
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const section = await this.curriculum.findSection(course.id, input.sectionId, trx);
      if (section === null) throw new SectionNotFound();
      const updated = await this.curriculum.updateSection(trx, course.id, section.id, input.patch);
      await this.courses.bumpVersion(trx, course.id);
      return toSectionView(updated);
    });
  }
}
