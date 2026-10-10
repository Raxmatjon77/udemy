import { Injectable } from '@nestjs/common';
import { WorkerConfigService } from '../../shared/config';

/** Links in catalog mails: the app routes of design §7/§10 (origins validated at startup). */
@Injectable()
export class CatalogLinks {
  constructor(private readonly config: WorkerConfigService) {}

  /** Admin review page (`web-admin` `/course-reviews/[revisionId]`). */
  courseReview(revisionId: string): string {
    return `${this.config.get('ADMIN_APP_ORIGIN')}/course-reviews/${encodeURIComponent(revisionId)}`;
  }

  /** The instructor's course builder (`web-instructor` `/courses/[id]`, Review tab shows decisions). */
  courseBuilder(courseId: string): string {
    return `${this.config.get('INSTRUCTOR_APP_ORIGIN')}/courses/${encodeURIComponent(courseId)}`;
  }

  /** Public landing page (`web-student` `/course/[slug]`). */
  publicCourse(slug: string): string {
    return `${this.config.get('STUDENT_APP_ORIGIN')}/course/${encodeURIComponent(slug)}`;
  }
}
