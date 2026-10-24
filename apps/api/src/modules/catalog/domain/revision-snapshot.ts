import { createHash } from 'node:crypto';
import type { CourseLanguage, CourseLevel, LectureType, QuizQuestionKind } from '@udemy/contracts';

/**
 * The reviewable content of a course (D1): exactly what a revision freezes and what
 * `content_hash` covers (design §4: details, bullets, ordered sections and lectures, asset ids,
 * article bodies). Order is meaningful: sections and lectures are in curriculum order, bullets
 * in list order, so a reorder is a change.
 *
 * Deliberately NOT part of it: the slug (frozen at first publication, not reviewable),
 * timestamps, the submitter note, and video durations (a READY asset is immutable, so its id
 * already pins the duration).
 *
 * Phase 5 (D6): a QUIZ lecture also carries its quiz (pass mark, questions, options and the
 * answer key), so editing a question is a reviewable change and the key is frozen per revision.
 */

/** One answer option of a snapshotted question; its position is its index (0-based). */
export interface SnapshotQuizOption {
  readonly text: string;
  readonly isCorrect: boolean;
}

/** One question, with its answer key (`isCorrect`) and explanation. */
export interface SnapshotQuizQuestion {
  /** The stable working-copy question id (`revision_quiz_questions.question_id`). */
  readonly id: string;
  readonly kind: QuizQuestionKind;
  readonly promptMd: string;
  readonly explanationMd: string | null;
  /** In position order. */
  readonly options: readonly SnapshotQuizOption[];
}

/** The quiz of a QUIZ lecture, answer key included (never sent to learners as is). */
export interface SnapshotQuiz {
  readonly passPct: number;
  /** In position order. */
  readonly questions: readonly SnapshotQuizQuestion[];
}

export interface SnapshotLecture {
  readonly id: string;
  readonly type: LectureType;
  readonly title: string;
  readonly descriptionMd: string | null;
  readonly isPreview: boolean;
  readonly mediaAssetId: string | null;
  /** ARTICLE lectures only (the body as stored, never trimmed); null otherwise. */
  readonly articleBodyMd: string | null;
  /** QUIZ lectures only (an empty quiz has no questions); null otherwise. */
  readonly quiz: SnapshotQuiz | null;
}

export interface SnapshotSection {
  readonly id: string;
  readonly title: string;
  readonly objective: string | null;
  readonly lectures: readonly SnapshotLecture[];
}

export interface SnapshotContent {
  readonly title: string;
  readonly subtitle: string | null;
  readonly descriptionMd: string | null;
  readonly language: CourseLanguage | null;
  readonly level: CourseLevel | null;
  readonly categoryId: string | null;
  readonly thumbnailAssetId: string | null;
  readonly outcomes: readonly string[];
  readonly requirements: readonly string[];
  readonly sections: readonly SnapshotSection[];
}

/** Bump when the canonical form changes (old hashes then simply never match new ones). */
export const SNAPSHOT_FORMAT_VERSION = 1;

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, arrays in order.
 * `JSON.stringify` escapes strings deterministically, and only finite numbers, strings,
 * booleans and null are allowed, so equal content always gives byte-identical output.
 */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly Json[]).map(canonicalJson).join(',')}]`;
  }
  const object = value as { readonly [key: string]: Json };
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as Json)}`).join(',')}}`;
}

function toJson(content: SnapshotContent): Json {
  return {
    v: SNAPSHOT_FORMAT_VERSION,
    title: content.title,
    subtitle: content.subtitle,
    descriptionMd: content.descriptionMd,
    language: content.language,
    level: content.level,
    categoryId: content.categoryId,
    thumbnailAssetId: content.thumbnailAssetId,
    outcomes: [...content.outcomes],
    requirements: [...content.requirements],
    sections: content.sections.map((section) => ({
      id: section.id,
      title: section.title,
      objective: section.objective,
      lectures: section.lectures.map(lectureJson),
    })),
  };
}

/**
 * The `quiz` member exists only on QUIZ lectures: every other lecture keeps exactly the
 * pre-Phase-5 canonical form, so the `content_hash` of every revision submitted before QUIZ
 * existed still matches its unchanged working copy (no spurious "unpublished changes", and
 * `nothing_to_review` keeps working) without bumping `SNAPSHOT_FORMAT_VERSION`.
 */
function lectureJson(lecture: SnapshotLecture): Json {
  const base = {
    id: lecture.id,
    type: lecture.type,
    title: lecture.title,
    descriptionMd: lecture.descriptionMd,
    isPreview: lecture.isPreview,
    mediaAssetId: lecture.mediaAssetId,
    articleBodyMd: lecture.articleBodyMd,
  };
  if (lecture.quiz === null) return base;
  return {
    ...base,
    quiz: {
      passPct: lecture.quiz.passPct,
      questions: lecture.quiz.questions.map((question) => ({
        id: question.id,
        kind: question.kind,
        promptMd: question.promptMd,
        explanationMd: question.explanationMd,
        options: question.options.map((option) => ({
          text: option.text,
          isCorrect: option.isCorrect,
        })),
      })),
    },
  };
}

/** Canonical JSON of a quiz (equality for the revision diff). */
export function quizFingerprint(quiz: SnapshotQuiz | null): string {
  if (quiz === null) return 'null';
  const json = lectureJson({
    id: '',
    type: 'QUIZ',
    title: '',
    descriptionMd: null,
    isPreview: false,
    mediaAssetId: null,
    articleBodyMd: null,
    quiz,
  }) as { readonly quiz: Json };
  return canonicalJson(json.quiz);
}

/** `content_hash`: SHA-256 of the canonical JSON (32 bytes, `course_revisions_content_hash_ck`). */
export function contentHash(content: SnapshotContent): Buffer {
  return createHash('sha256')
    .update(canonicalJson(toJson(content)), 'utf8')
    .digest();
}

/** Every media asset the content references (thumbnail and lecture media), ascending. */
export function referencedAssetIds(content: SnapshotContent): string[] {
  const ids = new Set<string>();
  if (content.thumbnailAssetId !== null) ids.add(content.thumbnailAssetId);
  for (const section of content.sections) {
    for (const lecture of section.lectures) {
      if (lecture.mediaAssetId !== null) ids.add(lecture.mediaAssetId);
    }
  }
  return [...ids].sort();
}
