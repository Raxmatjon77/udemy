import { Injectable } from '@nestjs/common';
import { MediaFacade } from '../../../media';
import { SectionNotFound } from '../../domain/catalog.errors';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface DeleteSectionInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly sectionId: string;
}

/**
 * `DeleteSection` (design §5): releases the media usage of each of its lectures (ascending
 * asset id), deletes the lectures (articles cascade) and the section, and compacts the
 * remaining section positions, in one transaction. Published versions survive in revisions.
 */
@Injectable()
export class DeleteSectionCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly media: MediaFacade,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: DeleteSectionInput): Promise<void> {
    await this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const section = await this.curriculum.findSection(course.id, input.sectionId, trx);
      if (section === null) throw new SectionNotFound();
      for (const ref of await this.curriculum.listLectureMedia(trx, course.id, section.id)) {
        await this.media.releaseConsumer(trx, { type: 'catalog.lecture', id: ref.lectureId });
      }
      await this.curriculum.deleteSection(trx, course.id, section.id);
      await this.courses.bumpVersion(trx, course.id);
    });
  }
}
