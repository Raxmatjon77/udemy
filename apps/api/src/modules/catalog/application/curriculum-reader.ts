import { Injectable } from '@nestjs/common';
import type { AssetView } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { MediaFacade } from '../../media';
import { plainTextLength } from '../domain/markdown';
import type { CourseRecord } from './ports/course.repository';
import {
  CurriculumRepository,
  type LectureRecord,
  type SectionRecord,
} from './ports/curriculum.repository';
import { QuizRepository, type WorkingQuizRecord } from './ports/quiz.repository';

export interface LoadedLecture {
  readonly record: LectureRecord;
  /** Fresh asset state; null without media (or when the asset no longer exists). */
  readonly asset: AssetView | null;
  /** ARTICLE lectures: plain-text length of the body (0 when never saved); else null. */
  readonly articlePlainLength: number | null;
  /** QUIZ lectures: the working-copy quiz (settings, questions, options); else null. */
  readonly quiz: WorkingQuizRecord | null;
}

export interface LoadedSection {
  readonly record: SectionRecord;
  readonly lectures: readonly LoadedLecture[];
}

/** The working-copy curriculum plus every asset it (and the thumbnail) references. */
export interface LoadedCurriculum {
  readonly sections: readonly LoadedSection[];
  /** Lecture assets and the course thumbnail, by asset id. */
  readonly assets: ReadonlyMap<string, AssetView>;
}

/**
 * Loads a course's curriculum with fresh media state in ONE `MediaFacade.getAssets` call
 * (design §5 GetCurriculum). Pass the caller's transaction to read inside it (writes returning
 * the new state; P2-T10's readiness check at submit).
 */
@Injectable()
export class CurriculumReader {
  constructor(
    private readonly curriculum: CurriculumRepository,
    private readonly quizzes: QuizRepository,
    private readonly media: MediaFacade,
  ) {}

  async load(course: CourseRecord, ex?: Executor): Promise<LoadedCurriculum> {
    const sections = await this.curriculum.listSections(course.id, ex);
    const lectures = await this.curriculum.listLectures(course.id, ex);
    const hasArticles = lectures.some((l) => l.type === 'ARTICLE');
    const bodies = hasArticles
      ? await this.curriculum.listArticleBodies(course.id, ex)
      : new Map<string, string>();
    const quizzes = lectures.some((l) => l.type === 'QUIZ')
      ? await this.quizzes.listCourseQuizzes(course.id, ex)
      : new Map<string, WorkingQuizRecord>();

    const assetIds = lectures.flatMap((l) => (l.mediaAssetId === null ? [] : [l.mediaAssetId]));
    if (course.thumbnailAssetId !== null) assetIds.push(course.thumbnailAssetId);
    const assets = new Map((await this.media.getAssets(assetIds, ex)).map((a) => [a.id, a]));

    const bySection = new Map<string, LoadedLecture[]>(sections.map((s) => [s.id, []]));
    for (const record of lectures) {
      bySection.get(record.sectionId)?.push({
        record,
        asset: record.mediaAssetId === null ? null : (assets.get(record.mediaAssetId) ?? null),
        articlePlainLength:
          record.type === 'ARTICLE' ? plainTextLength(bodies.get(record.id) ?? '') : null,
        quiz: record.type === 'QUIZ' ? (quizzes.get(record.id) ?? null) : null,
      });
    }
    return {
      sections: sections.map((record) => ({ record, lectures: bySection.get(record.id) ?? [] })),
      assets,
    };
  }

  /** One lecture with its fresh asset state, (ARTICLE) body length and (QUIZ) quiz. */
  async loadLecture(record: LectureRecord, ex?: Executor): Promise<LoadedLecture> {
    const [asset] =
      record.mediaAssetId === null ? [] : await this.media.getAssets([record.mediaAssetId], ex);
    const article =
      record.type === 'ARTICLE' ? await this.curriculum.findArticle(record.id, ex) : null;
    const quiz = record.type === 'QUIZ' ? await this.quizzes.findQuiz(record.id, ex) : null;
    return {
      record,
      asset: asset ?? null,
      articlePlainLength: record.type === 'ARTICLE' ? plainTextLength(article?.bodyMd ?? '') : null,
      quiz,
    };
  }
}
