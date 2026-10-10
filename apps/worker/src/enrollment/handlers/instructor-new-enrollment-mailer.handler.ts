import { Logger } from '@nestjs/common';
import {
  ENROLLMENT_ENROLLMENT_AGGREGATE,
  EnrollmentGranted,
  type EventEnvelope,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { eventMessageId, Mailer } from '@udemy/nest-common/mail';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { WorkerConfigService } from '../../shared/config';
import { UserContactReader } from '../../shared/mail/user-contact.reader';
import { EnrollmentLinks, instructorNewEnrollmentMail } from '../mail/enrollment-mail';
import { EnrolledCourseReader } from '../persistence/enrolled-course.reader';

/**
 * `EnrollmentGranted` -> "a new student enrolled" to the course owner (Phase 4 design §7),
 * behind `ENROLLMENT_INSTRUCTOR_MAIL_ENABLED` (default false).
 *
 * The handler stays registered while the flag is off, so the worker keeps consuming
 * `enrollment.enrollment` and the event is marked processed with no mail: switching the flag on
 * later does not mail the backlog. The payload is still validated (a broken contract is
 * dead-lettered either way). Nothing is sent when the owner enrolls in their own course.
 */
@EventHandler(ENROLLMENT_ENROLLMENT_AGGREGATE, EnrollmentGranted.type, {
  consumerName: 'enrollment.instructor-new-enrollment-mailer',
})
export class InstructorNewEnrollmentMailerHandler implements EventHandlerContract {
  private readonly logger = new Logger(InstructorNewEnrollmentMailerHandler.name);

  constructor(
    private readonly config: WorkerConfigService,
    private readonly courses: EnrolledCourseReader,
    private readonly contacts: UserContactReader,
    private readonly mailer: Mailer,
    private readonly links: EnrollmentLinks,
  ) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(EnrollmentGranted, envelope);
    if (!this.config.get('ENROLLMENT_INSTRUCTOR_MAIL_ENABLED')) return;

    const course = await this.courses.find(trx, event.courseId);
    if (course === null) {
      this.logger.warn(
        { courseId: event.courseId, enrollmentId: event.enrollmentId },
        'EnrollmentGranted for an unknown course; no mail',
      );
      return;
    }
    if (course.ownerId === event.userId) return;
    const owner = await this.contacts.find(trx, course.ownerId);
    if (owner === null) {
      this.logger.warn(
        { courseId: event.courseId, ownerId: course.ownerId },
        'EnrollmentGranted for a course whose owner is gone; no mail',
      );
      return;
    }
    await this.mailer.send({
      to: owner.email,
      ...instructorNewEnrollmentMail({
        displayName: owner.displayName,
        courseTitle: course.title,
        source: event.source,
        regrant: event.regrant,
        grantedAt: new Date(event.grantedAt),
        courseUrl: this.links.courseBuilder(event.courseId),
      }),
      messageId: eventMessageId(envelope.eventId),
    });
  }
}
