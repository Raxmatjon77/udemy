/**
 * Enrollment emails (Phase 4 design §7), rendered with the shared worker layout (escaped
 * values, one-line titles, http(s)-only links), and their links.
 */
import { Injectable } from '@nestjs/common';
import type { EnrollmentSource } from '@udemy/contracts';
import { WorkerConfigService } from '../../shared/config';
import { oneLine, type RenderedMail, renderMail, utc } from '../../shared/mail/mail-layout';

@Injectable()
export class EnrollmentLinks {
  constructor(private readonly config: WorkerConfigService) {}

  /** The instructor's course builder (`web-instructor` `/courses/[id]`). */
  courseBuilder(courseId: string): string {
    return `${this.config.get('INSTRUCTOR_APP_ORIGIN')}/courses/${encodeURIComponent(courseId)}`;
  }
}

const HOW: Readonly<Record<EnrollmentSource, string>> = {
  ORDER: 'with a purchase',
  FREE: 'for free',
  ADMIN: 'through an administrator',
};

/**
 * `enrollment.instructor-new-enrollment-mailer`. No student data (name or address) is shared
 * with the instructor: the mail says that someone enrolled, how, and when.
 */
export function instructorNewEnrollmentMail(input: {
  displayName: string;
  courseTitle: string;
  source: EnrollmentSource;
  regrant: boolean;
  grantedAt: Date;
  courseUrl: string;
}): RenderedMail {
  const title = `"${oneLine(input.courseTitle)}"`;
  const who = input.regrant ? 'A former student enrolled again in' : 'A new student enrolled in';
  return renderMail({
    subject: `New enrollment in ${title}`,
    greetingName: input.displayName,
    paragraphs: [`${who} ${title} ${HOW[input.source]} (${utc(input.grantedAt)}).`],
    action: { label: 'Open your course', url: input.courseUrl },
    footnote: 'You receive this email for every new enrollment in your courses.',
  });
}
