import { CatalogSettings } from '../catalog-settings';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CourseLocker } from '../course-locker';
import { CourseReadinessEvaluator } from '../course-readiness.evaluator';
import { CurriculumReader } from '../curriculum-reader';
import { ContentHashUnpublishedChangesDetector } from '../content-hash-unpublished-changes.detector';
import { WorkingCopySnapshotter } from '../working-copy-snapshotter';
import { AdminSearchCoursesQuery } from '../use-cases/admin-search-courses.query';
import { ApproveRevisionCommand } from '../use-cases/approve-revision.command';
import { ArchiveCourseCommand } from '../use-cases/archive-course.command';
import { GetCourseHistoryQuery } from '../use-cases/get-course-history.query';
import { GetRevisionReviewQuery } from '../use-cases/get-revision-review.query';
import { ListReviewQueueQuery } from '../use-cases/list-review-queue.query';
import { RejectRevisionCommand } from '../use-cases/reject-revision.command';
import { RestoreCourseCommand } from '../use-cases/restore-course.command';
import { SubmitCourseCommand } from '../use-cases/submit-course.command';
import { WithdrawSubmissionCommand } from '../use-cases/withdraw-submission.command';
import { AddLectureCommand } from '../use-cases/add-lecture.command';
import { AddSectionCommand } from '../use-cases/add-section.command';
import { AdminListCategoriesQuery } from '../use-cases/admin-list-categories.query';
import { AttachLectureMediaCommand } from '../use-cases/attach-lecture-media.command';
import { ClearCourseThumbnailCommand } from '../use-cases/clear-course-thumbnail.command';
import { CreateCategoryCommand } from '../use-cases/create-category.command';
import { CreateCourseCommand } from '../use-cases/create-course.command';
import { DeleteCategoryCommand } from '../use-cases/delete-category.command';
import { DeleteCourseCommand } from '../use-cases/delete-course.command';
import { DeleteLectureCommand } from '../use-cases/delete-lecture.command';
import { DeleteSectionCommand } from '../use-cases/delete-section.command';
import { DetachLectureMediaCommand } from '../use-cases/detach-lecture-media.command';
import { GetArticleQuery } from '../use-cases/get-article.query';
import { GetCourseQuery } from '../use-cases/get-course.query';
import { GetCurriculumQuery } from '../use-cases/get-curriculum.query';
import { ListCategoryTreeQuery } from '../use-cases/list-category-tree.query';
import { ListMyCoursesQuery } from '../use-cases/list-my-courses.query';
import { ReorderCategoriesCommand } from '../use-cases/reorder-categories.command';
import { ReorderCurriculumCommand } from '../use-cases/reorder-curriculum.command';
import { SaveArticleCommand } from '../use-cases/save-article.command';
import { SetCourseThumbnailCommand } from '../use-cases/set-course-thumbnail.command';
import { UpdateCategoryCommand } from '../use-cases/update-category.command';
import { UpdateCourseCommand } from '../use-cases/update-course.command';
import { UpdateLectureCommand } from '../use-cases/update-lecture.command';
import { UpdateSectionCommand } from '../use-cases/update-section.command';
import { AddQuizQuestionCommand } from '../use-cases/add-quiz-question.command';
import { DeleteQuizQuestionCommand } from '../use-cases/delete-quiz-question.command';
import { GetQuizQuery } from '../use-cases/get-quiz.query';
import { PutQuizQuestionOptionsCommand } from '../use-cases/put-quiz-question-options.command';
import { ReorderQuizQuestionsCommand } from '../use-cases/reorder-quiz-questions.command';
import { UpdateQuizQuestionCommand } from '../use-cases/update-quiz-question.command';
import { UpdateQuizSettingsCommand } from '../use-cases/update-quiz-settings.command';
import {
  CatalogWorld,
  FakeCatalogEventPublisher,
  FakeCategoryRepository,
  FakeCourseLifecycleRepository,
  FakeCoursePeopleDirectory,
  FakeCourseRepository,
  FakeCurriculumRepository,
  FakeMediaFacade,
  FakeQuizRepository,
  FakeRevisionRepository,
  FakeSubmissionRateLimiter,
  FakeTransactionRunner,
} from './catalog.fakes';

/** Every catalog use case wired to the in-memory fakes (one fresh world per call). */
export function createCatalogHarness(settings: CatalogSettings = CatalogSettings.defaults()) {
  const world = new CatalogWorld();
  const courses = new FakeCourseRepository(world);
  const lifecycle = new FakeCourseLifecycleRepository(world);
  const curriculum = new FakeCurriculumRepository(world);
  const quizzes = new FakeQuizRepository(world);
  const categories = new FakeCategoryRepository(world);
  const events = new FakeCatalogEventPublisher(world);
  const tx = new FakeTransactionRunner(world);
  const mediaFake = new FakeMediaFacade(world);
  const media = mediaFake.asFacade();
  const revisions = new FakeRevisionRepository(world);
  const people = new FakeCoursePeopleDirectory();
  const rateLimiter = new FakeSubmissionRateLimiter();
  const snapshotter = new WorkingCopySnapshotter(courses, curriculum, quizzes);

  const locker = new CourseLocker(courses);
  const reader = new CurriculumReader(curriculum, quizzes, media);
  const readiness = new CourseReadinessEvaluator(courses, categories, reader, settings);
  const detail = new CourseDetailAssembler(
    courses,
    lifecycle,
    reader,
    readiness,
    new ContentHashUnpublishedChangesDetector(snapshotter, revisions),
  );

  return {
    world,
    courses,
    lifecycle,
    curriculum,
    quizzes,
    categories,
    events,
    tx,
    media: mediaFake,
    readiness,
    revisions,
    people,
    rateLimiter,
    // categories
    adminListCategories: new AdminListCategoriesQuery(categories),
    listCategoryTree: new ListCategoryTreeQuery(categories),
    createCategory: new CreateCategoryCommand(categories, tx),
    updateCategory: new UpdateCategoryCommand(categories, tx),
    reorderCategories: new ReorderCategoriesCommand(categories, tx),
    deleteCategory: new DeleteCategoryCommand(categories, tx),
    // courses
    listMyCourses: new ListMyCoursesQuery(courses),
    createCourse: new CreateCourseCommand(courses, lifecycle, categories, events, detail, tx),
    getCourse: new GetCourseQuery(courses, detail),
    updateCourse: new UpdateCourseCommand(courses, categories, locker, detail, tx),
    setThumbnail: new SetCourseThumbnailCommand(courses, media, locker, detail, tx),
    clearThumbnail: new ClearCourseThumbnailCommand(courses, media, locker, detail, tx),
    deleteCourse: new DeleteCourseCommand(
      courses,
      curriculum,
      lifecycle,
      media,
      events,
      locker,
      tx,
    ),
    // curriculum
    getCurriculum: new GetCurriculumQuery(courses, reader),
    reorderCurriculum: new ReorderCurriculumCommand(courses, curriculum, reader, locker, tx),
    addSection: new AddSectionCommand(courses, curriculum, locker, tx),
    updateSection: new UpdateSectionCommand(courses, curriculum, locker, tx),
    deleteSection: new DeleteSectionCommand(courses, curriculum, media, locker, tx),
    addLecture: new AddLectureCommand(courses, curriculum, quizzes, locker, tx),
    updateLecture: new UpdateLectureCommand(courses, curriculum, reader, locker, tx),
    deleteLecture: new DeleteLectureCommand(courses, curriculum, media, locker, tx),
    getArticle: new GetArticleQuery(courses, curriculum),
    saveArticle: new SaveArticleCommand(courses, curriculum, locker, tx),
    attachMedia: new AttachLectureMediaCommand(courses, curriculum, reader, media, locker, tx),
    detachMedia: new DetachLectureMediaCommand(courses, curriculum, reader, media, locker, tx),
    // lifecycle and moderation
    submit: new SubmitCourseCommand(
      courses,
      categories,
      lifecycle,
      revisions,
      reader,
      readiness,
      snapshotter,
      media,
      events,
      rateLimiter,
      locker,
      tx,
    ),
    withdraw: new WithdrawSubmissionCommand(courses, lifecycle, media, events, locker, detail, tx),
    approve: new ApproveRevisionCommand(courses, lifecycle, media, events, locker, detail, tx),
    reject: new RejectRevisionCommand(courses, lifecycle, media, events, locker, detail, tx),
    archive: new ArchiveCourseCommand(courses, lifecycle, media, events, locker, detail, tx),
    restore: new RestoreCourseCommand(courses, lifecycle, events, locker, detail, tx),
    history: new GetCourseHistoryQuery(courses, lifecycle, people),
    reviewQueue: new ListReviewQueueQuery(lifecycle, people),
    revisionReview: new GetRevisionReviewQuery(courses, revisions, categories, people, media),
    adminCourses: new AdminSearchCoursesQuery(courses, people),
    // quizzes (Phase 5)
    getQuiz: new GetQuizQuery(courses, curriculum, quizzes),
    updateQuizSettings: new UpdateQuizSettingsCommand(courses, curriculum, quizzes, locker, tx),
    addQuizQuestion: new AddQuizQuestionCommand(courses, curriculum, quizzes, locker, tx),
    updateQuizQuestion: new UpdateQuizQuestionCommand(courses, curriculum, quizzes, locker, tx),
    deleteQuizQuestion: new DeleteQuizQuestionCommand(courses, curriculum, quizzes, locker, tx),
    putQuizOptions: new PutQuizQuestionOptionsCommand(courses, curriculum, quizzes, locker, tx),
    reorderQuizQuestions: new ReorderQuizQuestionsCommand(courses, curriculum, quizzes, locker, tx),
  };
}

export type CatalogHarness = ReturnType<typeof createCatalogHarness>;
