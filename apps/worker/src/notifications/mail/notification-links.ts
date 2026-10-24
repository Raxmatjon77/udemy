import { Injectable } from '@nestjs/common';
import { NOTIFICATION_CATEGORY_META, type NotificationCategory } from '@udemy/contracts';
import { HmacUnsubscribeTokenCodec, isUnsubscribable } from '@udemy/nest-common/unsubscribe';
import { WorkerConfigService } from '../../shared/config';
import type { MailLayout } from '../../shared/mail/mail-layout';

/** The RFC 8058 header pair of a notification e-mail. */
export interface UnsubscribeHeaders {
  readonly 'List-Unsubscribe': string;
  readonly 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click';
}

/**
 * Links in notification e-mails (routes of design §10; origins validated at startup) and the
 * one-click unsubscribe of design §14:
 *
 * - header  `List-Unsubscribe: <{STUDENT_APP_ORIGIN}/api/notifications/unsubscribe?token=…>`
 *           `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (the student BFF route)
 * - footer  `{STUDENT_APP_ORIGIN}/unsubscribe#token=…` (the page POSTs it; a fragment never
 *           reaches a server log)
 *
 * The token is signed by the shared `HmacUnsubscribeTokenCodec` (`@udemy/nest-common`), the
 * same class the api verifies with. Instructor and admin e-mails use the student origin too:
 * the token alone identifies the user. Locked categories (MODERATION) get neither.
 */
@Injectable()
export class NotificationLinks {
  constructor(
    private readonly config: WorkerConfigService,
    private readonly tokens: HmacUnsubscribeTokenCodec,
  ) {}

  private student(path: string): string {
    return `${this.config.get('STUDENT_APP_ORIGIN')}${path}`;
  }

  private instructor(path: string): string {
    return `${this.config.get('INSTRUCTOR_APP_ORIGIN')}${path}`;
  }

  /** The course player (`/learn/[courseId]`): Q&A, announcements and reviews of a course. */
  learn(courseId: string): string {
    return this.student(`/learn/${encodeURIComponent(courseId)}`);
  }

  /** Public certificate verification (`/certificates/[code]`); also the PDF's QR target. */
  certificate(code: string): string {
    return this.student(`/certificates/${encodeURIComponent(code)}`);
  }

  /** The instructor Q&A inbox filtered to one course. */
  instructorQa(courseId: string): string {
    return this.instructor(`/qa?courseId=${encodeURIComponent(courseId)}`);
  }

  /** The instructor's course page (reviews tab, builder). */
  instructorCourse(courseId: string): string {
    return this.instructor(`/courses/${encodeURIComponent(courseId)}`);
  }

  /** The admin moderation queue. */
  adminModeration(): string {
    return `${this.config.get('ADMIN_APP_ORIGIN')}/moderation`;
  }

  /** Notification settings (student app; the same account signs in there). */
  preferences(): string {
    return this.student('/account/notifications');
  }

  /** null for a locked category: its e-mails are transactional and carry no unsubscribe. */
  unsubscribeToken(userId: string, category: NotificationCategory): string | null {
    if (!isUnsubscribable(category)) return null;
    return this.tokens.sign({ userId, category });
  }

  headers(token: string): UnsubscribeHeaders {
    return {
      'List-Unsubscribe': `<${this.student(`/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }

  footer(token: string, category: NotificationCategory): NonNullable<MailLayout['unsubscribe']> {
    return {
      url: this.student(`/unsubscribe#token=${encodeURIComponent(token)}`),
      preferencesUrl: this.preferences(),
      categoryLabel: NOTIFICATION_CATEGORY_META[category].label.toLowerCase(),
    };
  }
}
