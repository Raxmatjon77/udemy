// Public facade of the catalog context: the only file other modules may import.
export { CatalogModule } from './catalog.module';
export {
  CatalogFacade,
  COURSE_SUMMARIES_MAX_IDS,
  LIVE_CURRICULUM_INDEX_MAX_IDS,
  type CourseSummary,
  type LiveCurriculum,
  type LiveCurriculumIndexEntry,
  type LiveCurriculumLecture,
  type LiveCurriculumSection,
  type LiveLectureRef,
  type PublishedCourseSummary,
  type QuizAnswerKey,
  type QuizForAttempt,
} from './application/catalog.facade';
