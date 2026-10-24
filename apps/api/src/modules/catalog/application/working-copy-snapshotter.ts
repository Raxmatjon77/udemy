import { Injectable } from '@nestjs/common';
import type { Executor } from '@udemy/db';
import { QUIZ_LIMITS } from '../domain/quiz';
import type { SnapshotContent, SnapshotQuiz } from '../domain/revision-snapshot';
import { type CourseBullets, type CourseRecord, CourseRepository } from './ports/course.repository';
import {
  CurriculumRepository,
  type LectureRecord,
  type SectionRecord,
} from './ports/curriculum.repository';
import { QuizRepository, type WorkingQuizRecord } from './ports/quiz.repository';

/** The reviewable part of a working-copy quiz (an empty quiz stays empty: readiness blocks it). */
export function toSnapshotQuiz(quiz: WorkingQuizRecord | null | undefined): SnapshotQuiz {
  return {
    passPct: quiz?.settings.passPct ?? QUIZ_LIMITS.defaultPassPct,
    questions: (quiz?.questions ?? []).map((q) => ({
      id: q.id,
      kind: q.kind,
      promptMd: q.promptMd,
      explanationMd: q.explanationMd,
      options: [...q.options]
        .sort((a, b) => a.position - b.position)
        .map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
    })),
  };
}

/**
 * The reviewable content of a working copy (pure): header, bullets, then sections and
 * lectures in curriculum order with their article bodies and (QUIZ) quizzes. `lectures` must be
 * ordered by section position then lecture position (as `CurriculumRepository.listLectures`
 * returns them).
 */
export function toSnapshotContent(
  course: CourseRecord,
  bullets: CourseBullets,
  sections: readonly SectionRecord[],
  lectures: readonly LectureRecord[],
  articleBodies: ReadonlyMap<string, string>,
  quizzes: ReadonlyMap<string, WorkingQuizRecord> = new Map(),
): SnapshotContent {
  return {
    title: course.title,
    subtitle: course.subtitle,
    descriptionMd: course.descriptionMd,
    language: course.language,
    level: course.level,
    categoryId: course.categoryId,
    thumbnailAssetId: course.thumbnailAssetId,
    outcomes: [...bullets.outcomes],
    requirements: [...bullets.requirements],
    sections: [...sections]
      .sort((a, b) => a.position - b.position)
      .map((section) => ({
        id: section.id,
        title: section.title,
        objective: section.objective,
        lectures: lectures
          .filter((l) => l.sectionId === section.id)
          .sort((a, b) => a.position - b.position)
          .map((l) => ({
            id: l.id,
            type: l.type,
            title: l.title,
            descriptionMd: l.descriptionMd,
            isPreview: l.isPreview,
            mediaAssetId: l.type === 'ARTICLE' ? null : l.mediaAssetId,
            articleBodyMd: l.type === 'ARTICLE' ? (articleBodies.get(l.id) ?? '') : null,
            quiz: l.type === 'QUIZ' ? toSnapshotQuiz(quizzes.get(l.id)) : null,
          })),
      })),
  };
}

/**
 * Reads a working copy's reviewable content (D1 snapshot input). Pass the caller's transaction
 * to read inside it (SubmitCourse holds the course lock, so nothing can change underneath).
 */
@Injectable()
export class WorkingCopySnapshotter {
  constructor(
    private readonly courses: CourseRepository,
    private readonly curriculum: CurriculumRepository,
    private readonly quizzes: QuizRepository,
  ) {}

  async content(course: CourseRecord, ex?: Executor): Promise<SnapshotContent> {
    const bullets = await this.courses.getBullets(course.id, ex);
    const sections = await this.curriculum.listSections(course.id, ex);
    const lectures = await this.curriculum.listLectures(course.id, ex);
    const bodies = lectures.some((l) => l.type === 'ARTICLE')
      ? await this.curriculum.listArticleBodies(course.id, ex)
      : new Map<string, string>();
    const quizzes = lectures.some((l) => l.type === 'QUIZ')
      ? await this.quizzes.listCourseQuizzes(course.id, ex)
      : new Map<string, WorkingQuizRecord>();
    return toSnapshotContent(course, bullets, sections, lectures, bodies, quizzes);
  }
}
