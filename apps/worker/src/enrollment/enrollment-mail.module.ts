import { Module } from '@nestjs/common';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import { InstructorNewEnrollmentMailerHandler } from './handlers/instructor-new-enrollment-mailer.handler';
import { EnrollmentLinks } from './mail/enrollment-mail';
import { EnrolledCourseReader } from './persistence/enrolled-course.reader';

/**
 * Consumers of the `enrollment.enrollment` topic that send email (Phase 4 design §7): the
 * flagged instructor new-enrollment mail. Relies on the global MailModule and
 * WorkerConfigModule; the registry ensures the topic and its `.dlq` at startup.
 */
@Module({
  providers: [
    EnrollmentLinks,
    UserContactReader,
    EnrolledCourseReader,
    InstructorNewEnrollmentMailerHandler,
  ],
})
export class EnrollmentMailModule {}
