import { Injectable } from '@nestjs/common';
import type { LectureType } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { MediaFacade } from '../../media';
import { type LearnerQuiz, type QuizKey, toLearnerQuiz, toQuizKey } from '../domain/quiz';
import type { SnapshotQuiz } from '../domain/revision-snapshot';
import { deepFreeze, LiveRevisionCache } from './live-revision-cache';
import { type LiveCourseRecord, PublicCatalogRepository } from './ports/public-catalog.repository';
import {
  type RevisionOutline,
  type RevisionOutlineLecture,
  RevisionRepository,
} from './ports/revision.repository';
import { isServableThumbnail } from './public-catalog-support';

/** At most this many course ids from `getOwnedLiveCourseIds` (design §5 InstructorQaInbox). */
export const OWNED_LIVE_COURSES_MAX = 100;

/** At most this many ids per `getCourseSummaries` call (a cart holds 20, a page 48). */
export const COURSE_SUMMARIES_MAX_IDS = 100;

/** At most this many ids per `getLiveCurriculumIndex` call (a "My learning" page holds 48). */
export const LIVE_CURRICULUM_INDEX_MAX_IDS = 48;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A course with a live revision, as other contexts see it (design §3 `CourseSummary`). */
export interface PublishedCourseSummary {
  readonly id: string;
  readonly slug: string;
  readonly ownerId: string;
  /**
   * `PUBLISHED`: listed and sellable. `ARCHIVED`: hidden from the catalog, but its live
   * revision stays readable for the owner, moderators and entitled users (D13).
   */
  readonly status: 'PUBLISHED' | 'ARCHIVED';
  readonly liveRevisionId: string;
  readonly firstPublishedAt: Date;
}

/**
 * What commerce (cart, order-line snapshots) and enrollment ("My learning") show of a course
 * (commerce & enrollment design §3): the LIVE revision's title, never the working copy's.
 */
export interface CourseSummary {
  readonly id: string;
  readonly slug: string;
  readonly ownerId: string;
  /** `PUBLISHED`: sellable. `ARCHIVED`: not for sale, still shown to enrolled users (D13). */
  readonly status: 'PUBLISHED' | 'ARCHIVED';
  readonly liveRevisionId: string;
  /** The live revision's title (what was approved; what an order line snapshots). */
  readonly title: string;
  /** The live thumbnail can be served (READY, not purged, has the w750 rendition). */
  readonly hasThumbnail: boolean;
}

/** One lecture of the live curriculum (Phase 5 design §3). Never carries content or keys. */
export interface LiveCurriculumLecture {
  readonly id: string;
  readonly type: LectureType;
  readonly title: string;
  /** VIDEO only (frozen at submit); null otherwise. */
  readonly durationSeconds: number | null;
  readonly isPreview: boolean;
  /** VIDEO/RESOURCE asset; null for ARTICLE and QUIZ. */
  readonly mediaAssetId: string | null;
  /** QUIZ only: the pass mark and question count; null otherwise. */
  readonly quiz: { readonly questionCount: number; readonly passPct: number } | null;
}

export interface LiveCurriculumSection {
  readonly id: string;
  readonly title: string;
  readonly lectures: readonly LiveCurriculumLecture[];
}

/**
 * The live revision's curriculum of a PUBLISHED or ARCHIVED course, keyed by id (the player;
 * ARCHIVED courses stay playable for entitled users, D13). Deep-frozen: do not mutate.
 */
export interface LiveCurriculum {
  readonly courseId: string;
  readonly ownerId: string;
  readonly status: 'PUBLISHED' | 'ARCHIVED';
  readonly liveRevisionId: string;
  readonly slug: string;
  /** The live revision's (approved) title. */
  readonly title: string;
  readonly sections: readonly LiveCurriculumSection[];
}

/** One lecture of a course's live revision (learning hot path: heartbeats, completions). */
export interface LiveLectureRef {
  readonly courseId: string;
  readonly ownerId: string;
  /** Not in the design §3 sketch; added so learners of ARCHIVED courses can be told apart. */
  readonly status: 'PUBLISHED' | 'ARCHIVED';
  readonly liveRevisionId: string;
  readonly lectureId: string;
  readonly type: LectureType;
  /** VIDEO only (frozen at submit); null otherwise. */
  readonly durationSeconds: number | null;
  /** VIDEO/RESOURCE asset; null for ARTICLE and QUIZ. */
  readonly mediaAssetId: string | null;
}

/** Progress denominators of one course (`getLiveCurriculumIndex`). */
export interface LiveCurriculumIndexEntry {
  readonly liveRevisionId: string;
  /** In curriculum order. */
  readonly lectureIds: readonly string[];
  /** Sum of the live VIDEO durations (seconds). */
  readonly videoSecondsTotal: number;
}

/**
 * LEARNER-SAFE quiz of the live revision (`getQuizForAttempt`): questions and option texts,
 * and NOTHING of the answer key (no `isCorrect`, no correct positions, no explanation). This is
 * the only quiz shape learning may put into a student response before a pass.
 */
export interface QuizForAttempt extends LearnerQuiz {
  /** The revision the attempt is graded against (snapshot it at START). */
  readonly revisionId: string;
}

/**
 * The ANSWER KEY of a revision's quiz (`getQuizAnswerKey`): server-side grading and, per Q5,
 * the reveal after a PASSED attempt. Never serialize it into a response before that.
 */
export interface QuizAnswerKey extends QuizKey {
  readonly revisionId: string;
  readonly lectureId: string;
}

/**
 * Public facade of the catalog context for other modules (design §3). Phase 2 has no
 * in-process consumer; these are the seams Phase 4 (commerce, enrollment) and Phase 5
 * (learning) need, and nothing more. Everything reads the LIVE revision, never the working
 * copy. Read methods take an optional executor so callers can read inside their transaction.
 */
@Injectable()
export class CatalogFacade {
  constructor(
    private readonly publicCatalog: PublicCatalogRepository,
    private readonly revisions: RevisionRepository,
    private readonly media: MediaFacade,
    private readonly cache: LiveRevisionCache,
  ) {}

  /**
   * Batch read for commerce and enrollment (two queries, whatever the count): the PUBLISHED
   * or ARCHIVED courses among `courseIds`, in the order of their first occurrence. Unknown,
   * malformed, never-published and deleted ids are omitted (callers report them as
   * unavailable). Commerce sells only `status === 'PUBLISHED'`.
   *
   * @throws RangeError for more than `COURSE_SUMMARIES_MAX_IDS` distinct ids (a caller bug).
   */
  async getCourseSummaries(courseIds: readonly string[], ex?: Executor): Promise<CourseSummary[]> {
    const ids = [...new Set(courseIds)];
    if (ids.length > COURSE_SUMMARIES_MAX_IDS) {
      throw new RangeError(
        `getCourseSummaries: ${ids.length} ids (at most ${COURSE_SUMMARIES_MAX_IDS})`,
      );
    }
    const valid = ids.filter((id) => UUID.test(id));
    if (valid.length === 0) return [];
    const courses = await this.publicCatalog.findLiveCourseSummaries(valid, ex);
    if (courses.length === 0) return [];
    const thumbnails = await this.media.getAssets(
      courses.map((c) => c.thumbnailAssetId),
      ex,
    );
    const servable = new Set(thumbnails.filter(isServableThumbnail).map((a) => a.id));
    const byId = new Map(courses.map((c) => [c.id, c]));
    return valid.flatMap((id): CourseSummary[] => {
      const course = byId.get(id);
      if (course === undefined) return [];
      return [
        {
          id: course.id,
          slug: course.slug,
          ownerId: course.ownerId,
          status: course.status,
          liveRevisionId: course.liveRevisionId,
          title: course.title,
          hasThumbnail: servable.has(course.thumbnailAssetId),
        },
      ];
    });
  }

  /**
   * The course if it has a live revision (PUBLISHED or ARCHIVED, never deleted), else null.
   * Commerce: sell only when `status === 'PUBLISHED'`.
   */
  async getPublishedCourse(
    courseId: string,
    ex?: Executor,
  ): Promise<PublishedCourseSummary | null> {
    const course = await this.publicCatalog.findLiveCourse(courseId, ex);
    if (course === null) return null;
    return {
      id: course.id,
      slug: course.slug,
      ownerId: course.ownerId,
      status: course.status,
      liveRevisionId: course.liveRevisionId,
      firstPublishedAt: course.firstPublishedAt,
    };
  }

  /**
   * Whether `lectureId` is part of the course's CURRENT live revision (learning: accept
   * progress only for lectures a student can actually see). False for unknown courses.
   */
  async lectureBelongsToLiveRevision(
    courseId: string,
    lectureId: string,
    ex?: Executor,
  ): Promise<boolean> {
    const found = await this.publicCatalog.findLiveLecture(
      courseId,
      lectureId,
      { withArticle: false },
      ex,
    );
    return found?.lecture != null;
  }

  /**
   * Ids of the owner's courses that have a live revision (PUBLISHED or ARCHIVED, never
   * deleted), the most recently first-published first, at most `OWNED_LIVE_COURSES_MAX`
   * (engagement's instructor Q&A inbox: questions exist only on live courses).
   */
  getOwnedLiveCourseIds(ownerId: string, ex?: Executor): Promise<string[]> {
    if (!UUID.test(ownerId)) return Promise.resolve([]);
    return this.publicCatalog.listLiveCourseIdsByOwner(ownerId, OWNED_LIVE_COURSES_MAX, ex);
  }

  /** Lecture ids of the live revision in curriculum order (progress denominator); [] if none. */
  getLiveLectureIds(courseId: string, ex?: Executor): Promise<string[]> {
    return this.publicCatalog.listLiveLectureIds(courseId, ex);
  }

  /* ------------------------------------------------------------------------------------
   * Phase 5 (learning experience design §3). The course row (status, owner, live pointer) is
   * read fresh unless stated otherwise; everything derived from a revision id comes from the
   * in-process LRU (`LiveRevisionCache`): revisions are immutable.
   * ---------------------------------------------------------------------------------- */

  /**
   * The live curriculum of a PUBLISHED or ARCHIVED course, or null (draft, deleted, unknown).
   * Outline only: no article body, no quiz content, no answer key.
   */
  async getLiveCurriculum(courseId: string, ex?: Executor): Promise<LiveCurriculum | null> {
    if (!UUID.test(courseId)) return null;
    const course = await this.publicCatalog.findLiveCourse(courseId, ex);
    if (course === null) return null;
    const outline = (await this.outlines([course.liveRevisionId], ex)).get(course.liveRevisionId);
    if (outline === undefined) return null;
    return deepFreeze({
      courseId: course.id,
      ownerId: course.ownerId,
      status: course.status,
      liveRevisionId: course.liveRevisionId,
      slug: course.slug,
      title: outline.title,
      sections: outline.sections.map((section) => ({
        id: section.id,
        title: section.title,
        lectures: section.lectures.map(toLiveLecture),
      })),
    });
  }

  /**
   * One lecture of the course's live revision, or null when the course is not live (draft,
   * deleted, unknown) OR the lecture is not part of its live revision; callers that must tell
   * the two 404s apart ask `getPublishedCourse` on the (rare) null path.
   *
   * Hot path (heartbeats): without `ex` the course -> live revision pointer is cached for 30 s
   * (an approve/archive/restore is seen within 30 s); with `ex` it is read fresh in the
   * caller's transaction. The lecture comes from the revision LRU either way.
   */
  async getLiveLecture(
    courseId: string,
    lectureId: string,
    ex?: Executor,
  ): Promise<LiveLectureRef | null> {
    if (!UUID.test(courseId) || !UUID.test(lectureId)) return null;
    const course = await this.livePointer(courseId, ex);
    if (course === null) return null;
    const outline = (await this.outlines([course.liveRevisionId], ex)).get(course.liveRevisionId);
    const lecture = outline?.sections
      .flatMap((section) => section.lectures)
      .find((l) => l.id === lectureId);
    if (lecture === undefined) return null;
    return {
      courseId: course.id,
      ownerId: course.ownerId,
      status: course.status,
      liveRevisionId: course.liveRevisionId,
      lectureId: lecture.id,
      type: lecture.type,
      durationSeconds: lecture.durationSeconds,
      mediaAssetId: lecture.mediaAssetId,
    };
  }

  /**
   * Progress denominators of up to `LIVE_CURRICULUM_INDEX_MAX_IDS` courses (My learning, the
   * refund consumption policy): one course query plus one batch for the uncached revisions.
   * Courses without a live revision (and malformed ids) are absent from the map.
   *
   * @throws RangeError for more than `LIVE_CURRICULUM_INDEX_MAX_IDS` distinct ids (a caller bug).
   */
  async getLiveCurriculumIndex(
    courseIds: readonly string[],
    ex?: Executor,
  ): Promise<Map<string, LiveCurriculumIndexEntry>> {
    const ids = [...new Set(courseIds)];
    if (ids.length > LIVE_CURRICULUM_INDEX_MAX_IDS) {
      throw new RangeError(
        `getLiveCurriculumIndex: ${ids.length} ids (at most ${LIVE_CURRICULUM_INDEX_MAX_IDS})`,
      );
    }
    const result = new Map<string, LiveCurriculumIndexEntry>();
    const valid = ids.filter((id) => UUID.test(id));
    if (valid.length === 0) return result;
    const courses = await this.publicCatalog.findLiveCourseSummaries(valid, ex);
    const outlines = await this.outlines(
      courses.map((c) => c.liveRevisionId),
      ex,
    );
    for (const course of courses) {
      const outline = outlines.get(course.liveRevisionId);
      if (outline === undefined) continue;
      const lectures = outline.sections.flatMap((section) => section.lectures);
      result.set(course.id, {
        liveRevisionId: course.liveRevisionId,
        lectureIds: lectures.map((l) => l.id),
        videoSecondsTotal: lectures.reduce(
          (sum, l) => sum + (l.type === 'VIDEO' ? (l.durationSeconds ?? 0) : 0),
          0,
        ),
      });
    }
    return result;
  }

  /**
   * LEARNER-SAFE: the quiz of a QUIZ lecture of the course's CURRENT live revision, without
   * any part of the answer key (see `QuizForAttempt`); learning snapshots `revisionId` when an
   * attempt starts. Null when the course is not live, the lecture is not in its live revision,
   * or it is not a QUIZ lecture (`getLiveLecture` tells which).
   */
  async getQuizForAttempt(
    courseId: string,
    lectureId: string,
    ex?: Executor,
  ): Promise<QuizForAttempt | null> {
    if (!UUID.test(courseId) || !UUID.test(lectureId)) return null;
    const course = await this.publicCatalog.findLiveCourse(courseId, ex);
    if (course === null) return null;
    const quiz = await this.revisionQuiz(course.liveRevisionId, lectureId, ex);
    if (quiz === null) return null;
    return { revisionId: course.liveRevisionId, ...toLearnerQuiz(quiz) };
  }

  /**
   * LEARNER-SAFE: the quiz of a QUIZ lecture of ANY revision (the allow-list view of
   * `getQuizForAttempt`, without any part of the answer key). Learning shows an attempt with
   * the questions of the revision it STARTED on, which may no longer be live (P5-T11), and
   * checks submitted option positions against it. Null when the lecture is not a QUIZ lecture
   * of that revision.
   */
  async getQuizForRevision(
    revisionId: string,
    lectureId: string,
    ex?: Executor,
  ): Promise<QuizForAttempt | null> {
    if (!UUID.test(revisionId) || !UUID.test(lectureId)) return null;
    const quiz = await this.revisionQuiz(revisionId, lectureId, ex);
    if (quiz === null) return null;
    return { revisionId, ...toLearnerQuiz(quiz) };
  }

  /**
   * GRADING ONLY: the answer key of a QUIZ lecture of ANY revision (the attempt's revision,
   * which may no longer be live). It has no HTTP route; learning grades with it server-side and
   * reveals `correct` / `explanationMd` only after a passed attempt (Q5). Null when the lecture
   * is not a QUIZ lecture of that revision.
   */
  async getQuizAnswerKey(
    revisionId: string,
    lectureId: string,
    ex?: Executor,
  ): Promise<QuizAnswerKey | null> {
    if (!UUID.test(revisionId) || !UUID.test(lectureId)) return null;
    const quiz = await this.revisionQuiz(revisionId, lectureId, ex);
    if (quiz === null) return null;
    return { revisionId, lectureId, ...toQuizKey(quiz) };
  }

  /** The live pointer: the 30 s cache without a transaction, a fresh read with one. */
  private async livePointer(courseId: string, ex?: Executor): Promise<LiveCourseRecord | null> {
    if (ex === undefined) {
      const cached = this.cache.livePointer(courseId);
      if (cached !== undefined) return cached;
    }
    const course = await this.publicCatalog.findLiveCourse(courseId, ex);
    if (course !== null && ex === undefined) this.cache.rememberLivePointer(course);
    return course;
  }

  /** Revision outlines from the LRU; the misses in one batch. */
  private async outlines(
    revisionIds: readonly string[],
    ex?: Executor,
  ): Promise<Map<string, RevisionOutline>> {
    const result = new Map<string, RevisionOutline>();
    const missing: string[] = [];
    for (const id of new Set(revisionIds)) {
      const cached = this.cache.outlines.get(id);
      if (cached === undefined) missing.push(id);
      else result.set(id, cached);
    }
    if (missing.length > 0) {
      for (const [id, outline] of await this.revisions.findOutlines(missing, ex)) {
        const frozen = deepFreeze(outline);
        this.cache.outlines.set(id, frozen);
        result.set(id, frozen);
      }
    }
    return result;
  }

  /** A revision's quiz (answer key included: internal only) from the LRU, else the DB. */
  private async revisionQuiz(
    revisionId: string,
    lectureId: string,
    ex?: Executor,
  ): Promise<SnapshotQuiz | null> {
    const key = LiveRevisionCache.quizKey(revisionId, lectureId);
    const cached = this.cache.quizzes.get(key);
    if (cached !== undefined) return cached;
    const quiz = await this.revisions.findQuiz(revisionId, lectureId, ex);
    // Misses are not cached: a null is cheap to re-read and never the normal path.
    if (quiz === null) return null;
    const frozen = deepFreeze(quiz);
    this.cache.quizzes.set(key, frozen);
    return frozen;
  }
}

function toLiveLecture(lecture: RevisionOutlineLecture): LiveCurriculumLecture {
  return {
    id: lecture.id,
    type: lecture.type,
    title: lecture.title,
    durationSeconds: lecture.durationSeconds,
    isPreview: lecture.isPreview,
    mediaAssetId: lecture.mediaAssetId,
    quiz:
      lecture.quiz === null
        ? null
        : { questionCount: lecture.quiz.questionCount, passPct: lecture.quiz.passPct },
  };
}
