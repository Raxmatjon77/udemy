import type { DB, Executor, Transaction } from '@udemy/db';
import { LectureNotFound, QuizQuestionNotFound } from '../domain/catalog.errors';
import { assertQuizLecture } from '../domain/quiz';
import type { CourseRecord, CourseRepository } from './ports/course.repository';
import type { CurriculumRepository, LectureRecord } from './ports/curriculum.repository';
import type {
  QuizQuestionRecord,
  QuizRepository,
  WorkingQuizRecord,
} from './ports/quiz.repository';

/**
 * A QUIZ lecture of THIS course (another course's lecture is 404, like every nested route).
 *
 * @throws LectureNotFound (404), LectureTypeMismatch (422) for a non-QUIZ lecture
 */
export async function requireQuizLecture(
  curriculum: CurriculumRepository,
  courseId: string,
  lectureId: string,
  ex?: Executor,
): Promise<LectureRecord> {
  const lecture = await curriculum.findLecture(courseId, lectureId, ex);
  if (lecture === null) throw new LectureNotFound();
  assertQuizLecture(lecture.type);
  return lecture;
}

/**
 * The working quiz of a QUIZ lecture. Every QUIZ lecture has its settings row (AddLecture
 * writes both; the deferred `lecture_quizzes_required_ck` guarantees it), so a miss is a bug.
 */
export async function requireQuiz(
  quizzes: QuizRepository,
  lectureId: string,
  ex?: Executor,
): Promise<WorkingQuizRecord> {
  const quiz = await quizzes.findQuiz(lectureId, ex);
  if (quiz === null) throw new Error(`QUIZ lecture ${lectureId} has no lecture_quizzes row`);
  return quiz;
}

/** @throws QuizQuestionNotFound (404) when the question is not part of THIS quiz */
export async function requireQuizQuestion(
  quizzes: QuizRepository,
  lectureId: string,
  questionId: string,
  ex?: Executor,
): Promise<QuizQuestionRecord> {
  const question = await quizzes.findQuestion(lectureId, questionId, ex);
  if (question === null) throw new QuizQuestionNotFound();
  return question;
}

/**
 * Ends every quiz write: the quiz's `updated_at` and the course `version` move on (quiz writes
 * are working-copy writes like curriculum writes). Returns the course with its new version.
 */
export async function finishQuizWrite(
  trx: Transaction<DB>,
  deps: { readonly courses: CourseRepository; readonly quizzes: QuizRepository },
  course: CourseRecord,
  lectureId: string,
): Promise<CourseRecord> {
  await deps.quizzes.touch(trx, lectureId);
  const version = await deps.courses.bumpVersion(trx, course.id);
  return { ...course, version };
}
