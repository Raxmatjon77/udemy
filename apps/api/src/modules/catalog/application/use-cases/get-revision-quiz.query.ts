import { Injectable } from '@nestjs/common';
import type { RevisionQuiz } from '@udemy/contracts';
import { LectureNotFound, RevisionNotFound } from '../../domain/catalog.errors';
import { assertQuizLecture } from '../../domain/quiz';
import { PublicCatalogRepository } from '../ports/public-catalog.repository';
import { RevisionRepository } from '../ports/revision.repository';

export interface GetRevisionQuizInput {
  readonly revisionId: string;
  readonly lectureId: string;
}

/**
 * `GetRevisionQuiz` (Phase 5 design §8 admin, `P course:read:any`): the immutable quiz of a
 * revision WITH its answer key, for the moderation review. The lecture is looked up in THAT
 * revision only. 404 `not_found` (revision) / `lecture_not_found`, 422 `lecture_type_mismatch`.
 */
@Injectable()
export class GetRevisionQuizQuery {
  constructor(
    private readonly publicCatalog: PublicCatalogRepository,
    private readonly revisions: RevisionRepository,
  ) {}

  async execute(input: GetRevisionQuizInput): Promise<RevisionQuiz> {
    const header = await this.publicCatalog.findRevisionHeader(input.revisionId);
    if (header === null) throw new RevisionNotFound();
    const lecture = await this.publicCatalog.findRevisionLecture(
      header.revisionId,
      input.lectureId,
      { withArticle: false },
    );
    if (lecture === null) throw new LectureNotFound();
    assertQuizLecture(lecture.type);
    const quiz = await this.revisions.findQuiz(header.revisionId, lecture.lectureId);
    // A QUIZ revision lecture always has its pass mark and 1..50 questions (deferred guards).
    if (quiz === null)
      throw new Error(`revision ${header.revisionId} quiz ${lecture.lectureId} is missing`);
    return {
      revisionId: header.revisionId,
      lectureId: lecture.lectureId,
      passPct: quiz.passPct,
      questions: quiz.questions.map((question, position) => ({
        id: question.id,
        position,
        kind: question.kind,
        promptMd: question.promptMd,
        explanationMd: question.explanationMd,
        options: question.options.map((option, optionPosition) => ({
          position: optionPosition,
          text: option.text,
          isCorrect: option.isCorrect,
        })),
      })),
    };
  }
}
