import type {
  AdminCategoryNode,
  Article,
  AssetView,
  Category,
  CategoryNode,
  Curriculum,
  CurriculumSection,
  Lecture,
  LectureQuizSummary,
  QuizAuthoring,
  QuizQuestionAuthoring,
  RevisionSummary,
  Section,
} from '@udemy/contracts';
import { isQuizQuestionComplete, QUIZ_LIMITS } from '../domain/quiz';
import { isEffectivelyActive } from '../domain/category';
import { isWorkingCopyLocked } from '../domain/course';
import { readyVideoSeconds } from '../domain/readiness';
import type { LoadedCurriculum, LoadedLecture } from './curriculum-reader';
import type { CategoryRecord, CategoryWithCount } from './ports/category.repository';
import type { RevisionSummaryRecord } from './ports/course-lifecycle.repository';
import type { CourseRecord } from './ports/course.repository';
import type { ArticleRecord, LectureRecord, SectionRecord } from './ports/curriculum.repository';
import type { QuizQuestionRecord, WorkingQuizRecord } from './ports/quiz.repository';

export function toSectionView(section: SectionRecord): Section {
  return {
    id: section.id,
    title: section.title,
    objective: section.objective,
    position: section.position,
    updatedAt: section.updatedAt.toISOString(),
  };
}

/** `Lecture.quiz` / the live curriculum's quiz summary: pass mark and question count. */
export function toQuizSummary(quiz: WorkingQuizRecord | null): LectureQuizSummary {
  return {
    passPct: quiz?.settings.passPct ?? QUIZ_LIMITS.defaultPassPct,
    questionCount: quiz?.questions.length ?? 0,
  };
}

export function toLectureView(
  lecture: LectureRecord,
  asset: AssetView | null,
  articlePlainLength: number | null,
  quiz: WorkingQuizRecord | null = null,
): Lecture {
  return {
    id: lecture.id,
    sectionId: lecture.sectionId,
    type: lecture.type,
    title: lecture.title,
    descriptionMd: lecture.descriptionMd,
    isPreview: lecture.isPreview,
    position: lecture.position,
    mediaAssetId: lecture.mediaAssetId,
    asset,
    articleLength: lecture.type === 'ARTICLE' ? (articlePlainLength ?? 0) : null,
    quiz: lecture.type === 'QUIZ' ? toQuizSummary(quiz) : null,
    updatedAt: lecture.updatedAt.toISOString(),
  };
}

export function toLoadedLectureView(lecture: LoadedLecture): Lecture {
  return toLectureView(lecture.record, lecture.asset, lecture.articlePlainLength, lecture.quiz);
}

/**
 * One working-copy question for its owner or an admin, ANSWER KEY INCLUDED (`isCorrect`,
 * `explanationMd`): only the authoring routes (`Pol course:read` / `course:update`) use it.
 */
export function toQuizQuestionAuthoringView(question: QuizQuestionRecord): QuizQuestionAuthoring {
  return {
    id: question.id,
    position: question.position,
    kind: question.kind,
    promptMd: question.promptMd,
    explanationMd: question.explanationMd,
    options: question.options.map((o) => ({
      position: o.position,
      text: o.text,
      isCorrect: o.isCorrect,
    })),
    complete: isQuizQuestionComplete(question.kind, question.options),
    updatedAt: question.updatedAt.toISOString(),
  };
}

/** The whole working-copy quiz for its owner or an admin (answer key included). */
export function toQuizAuthoringView(
  course: CourseRecord,
  lectureId: string,
  quiz: WorkingQuizRecord,
): QuizAuthoring {
  return {
    courseId: course.id,
    lectureId,
    version: course.version,
    locked: isWorkingCopyLocked(course),
    passPct: quiz.settings.passPct,
    questions: quiz.questions.map(toQuizQuestionAuthoringView),
    updatedAt: quiz.settings.updatedAt.toISOString(),
  };
}

export function toCurriculumView(course: CourseRecord, loaded: LoadedCurriculum): Curriculum {
  const sections: CurriculumSection[] = loaded.sections.map((s) => ({
    ...toSectionView(s.record),
    lectures: s.lectures.map(toLoadedLectureView),
  }));
  const lectures = loaded.sections.flatMap((s) => s.lectures);
  return {
    courseId: course.id,
    version: course.version,
    locked: isWorkingCopyLocked(course),
    sections,
    totals: {
      sectionCount: sections.length,
      lectureCount: lectures.length,
      previewCount: lectures.filter((l) => l.record.isPreview).length,
      videoSeconds: readyVideoSeconds(
        loaded.sections.map((s) => ({
          id: s.record.id,
          lectures: s.lectures.map((l) => ({
            id: l.record.id,
            type: l.record.type,
            mediaAssetId: l.record.mediaAssetId,
            asset: l.asset,
            articlePlainLength: l.articlePlainLength,
          })),
        })),
      ),
    },
  };
}

export function toArticleView(lectureId: string, article: ArticleRecord | null): Article {
  return {
    lectureId,
    bodyMd: article?.bodyMd ?? '',
    updatedAt: article === null ? null : article.updatedAt.toISOString(),
  };
}

export function toRevisionSummary(record: RevisionSummaryRecord): RevisionSummary {
  return {
    id: record.id,
    revisionNo: record.revisionNo,
    kind: record.kind,
    submittedAt: record.submittedAt.toISOString(),
  };
}

export function toCategoryView(category: CategoryRecord): Category {
  return {
    id: category.id,
    parentId: category.parentId,
    depth: category.depth,
    slug: category.slug,
    name: category.name,
    position: category.position,
    isActive: category.isActive,
  };
}

/** The admin tree (inactive included): groups by position, each with its leaves by position. */
export function toAdminCategoryTree(all: readonly CategoryWithCount[]): AdminCategoryNode[] {
  const byPosition = (a: CategoryRecord, b: CategoryRecord): number => a.position - b.position;
  const roots = all.filter((c) => c.depth === 1).sort(byPosition);
  return roots.map((root) => ({
    ...toCategoryView(root),
    courseCount: root.courseCount,
    children: all
      .filter((c) => c.parentId === root.id)
      .sort(byPosition)
      .map((leaf) => ({ ...toCategoryView(leaf), courseCount: leaf.courseCount })),
  }));
}

/** The public tree: active groups with their active leaves only. */
export function toPublicCategoryTree(all: readonly CategoryRecord[]): CategoryNode[] {
  const byPosition = (a: CategoryRecord, b: CategoryRecord): number => a.position - b.position;
  return all
    .filter((c) => c.depth === 1 && c.isActive)
    .sort(byPosition)
    .map((root) => ({
      id: root.id,
      slug: root.slug,
      name: root.name,
      children: all
        .filter((c) => c.parentId === root.id && isEffectivelyActive(c))
        .sort(byPosition)
        .map((leaf) => ({ id: leaf.id, slug: leaf.slug, name: leaf.name })),
    }));
}
