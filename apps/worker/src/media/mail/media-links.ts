import { Injectable } from '@nestjs/common';
import { WorkerConfigService } from '../../shared/config';

/** Links in media mails: instructor app routes of design §10 (origins validated at startup). */
@Injectable()
export class MediaLinks {
  constructor(private readonly config: WorkerConfigService) {}

  /** The course builder (`web-instructor` `/courses/[id]`). */
  courseBuilder(courseId: string): string {
    return `${this.config.get('INSTRUCTOR_APP_ORIGIN')}/courses/${encodeURIComponent(courseId)}`;
  }

  /** "My courses" (`/courses`), when the asset is not attached anywhere. */
  myCourses(): string {
    return `${this.config.get('INSTRUCTOR_APP_ORIGIN')}/courses`;
  }
}
