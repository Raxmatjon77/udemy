import { Injectable } from '@nestjs/common';
import { WorkerConfigService } from '../../shared/config';

/** Links in the instructor-application mails (origins validated at startup, design §10). */
@Injectable()
export class UsersLinks {
  constructor(private readonly config: WorkerConfigService) {}

  /** Sign-in page of the instructor app (`web-instructor`). */
  instructorLogin(): string {
    return `${this.config.get('INSTRUCTOR_APP_ORIGIN')}/login`;
  }

  /** The application page of the student app, where a rejected applicant can apply again. */
  becomeInstructor(): string {
    return `${this.config.get('STUDENT_APP_ORIGIN')}/become-instructor`;
  }
}
