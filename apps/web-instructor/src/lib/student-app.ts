import 'server-only';

import { serverEnv } from './env';

/** Absolute URL of the student app's "become an instructor" page. */
export function becomeInstructorUrl(): string {
  return `${serverEnv().STUDENT_APP_ORIGIN}/become-instructor`;
}
