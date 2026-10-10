import { Injectable } from '@nestjs/common';
import type { Article } from '@udemy/contracts';
import { LectureNotFound } from '../../domain/catalog.errors';
import { assertArticleLecture } from '../../domain/curriculum';
import { assertMarkdownAllowed } from '../../domain/markdown';
import { CourseLocker } from '../course-locker';
import { CourseRepository } from '../ports/course.repository';
import { CurriculumRepository } from '../ports/curriculum.repository';
import { TransactionRunner } from '../ports/transaction-runner';
import { toArticleView } from '../views';

export interface SaveArticleInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly lectureId: string;
  /** Stored verbatim (never trimmed); ≤ 100 000 characters (request schema). */
  readonly bodyMd: string;
}

/**
 * `SaveArticle` (design §5, D14): validates the markdown (422 `markdown_not_allowed` with one
 * issue per offending construct) and stores it on an ARTICLE lecture of this course (422
 * `lecture_type_mismatch` otherwise).
 */
@Injectable()
export class SaveArticleCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly locker: CourseLocker,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: SaveArticleInput): Promise<Article> {
    assertMarkdownAllowed('bodyMd', input.bodyMd);
    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      const lecture = await this.curriculum.findLecture(course.id, input.lectureId, trx);
      if (lecture === null) throw new LectureNotFound();
      assertArticleLecture(lecture.type);
      const article = await this.curriculum.saveArticle(trx, lecture.id, input.bodyMd);
      await this.courses.bumpVersion(trx, course.id);
      return toArticleView(lecture.id, article);
    });
  }
}
