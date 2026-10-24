import { Injectable } from '@nestjs/common';

/**
 * Injection token for the process-wide `CourseProgressReader` binding (Phase 5 learning
 * experience design D21, §3). `Symbol.for` keeps the token identical if this file is ever loaded
 * twice.
 *
 *   constructor(@Inject(COURSE_PROGRESS) private readonly progress: CourseProgressReader)
 */
export const COURSE_PROGRESS = Symbol.for('udemy.COURSE_PROGRESS');

/**
 * Port: "how far is this user through these courses?" Enrollment asks it for the my-learning
 * cards (`LearningCard.progress`, an integer 0–100 or null).
 *
 * It lives in `shared` so the dependency is inverted: learning imports enrollment (access
 * checks), so enrollment cannot import learning. Enrollment depends on this interface, learning
 * implements it (`LearningProgressReader`, P5-T10), and only AppModule knows both.
 */
export interface CourseProgressReader {
  /**
   * Percent complete (integer 0–100) per course id. A course without a value (no progress yet,
   * no live curriculum, or no reader bound) is absent from the map: callers show `null`.
   */
  getPercents(userId: string, courseIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

/**
 * Default binding until learning binds `LearningProgressReader` (P5-T10): progress is unknown
 * for every course, so the my-learning cards keep `progress: null`.
 */
@Injectable()
export class NoCourseProgress implements CourseProgressReader {
  getPercents(): Promise<ReadonlyMap<string, number>> {
    return Promise.resolve(new Map<string, number>());
  }
}
