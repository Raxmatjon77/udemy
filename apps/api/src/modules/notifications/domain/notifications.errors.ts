import { ErrorCode, type NotificationCategory, type NotificationChannel } from '@udemy/contracts';
import { NotFoundError, ValidationError } from '@udemy/nest-common/errors';

interface CauseOption {
  readonly cause?: unknown;
}

/**
 * 404 `notification_not_found`: no such notification in the caller's inbox (another user's or
 * another app's row answers the same, so ids cannot be probed).
 */
export class NotificationNotFound extends NotFoundError {
  constructor(options: CauseOption = {}) {
    super('The notification does not exist.', {
      code: ErrorCode.NotificationNotFound,
      cause: options.cause,
    });
  }
}

/** 422 `preference_locked`: a transactional (category, channel) pair cannot be changed. */
export class PreferenceLocked extends ValidationError {
  constructor(
    pairs: readonly { category: NotificationCategory; channel: NotificationChannel }[],
    options: CauseOption = {},
  ) {
    const message = 'Some notification settings cannot be changed.';
    super(message, {
      code: ErrorCode.PreferenceLocked,
      issues: pairs.map((p) => ({
        path: `items.${p.category}.${p.channel}`,
        message: `${p.category} ${p.channel} notifications are always on.`,
      })),
      cause: options.cause,
    });
  }
}

/**
 * `invalid_unsubscribe_token`: malformed, forged, wrong version, or for a locked category. A
 * `ValidationError` (no 400 kind exists); the unsubscribe controller answers it with **400**
 * (design §5). The message never echoes the token.
 */
export class InvalidUnsubscribeToken extends ValidationError {
  constructor(options: CauseOption = {}) {
    super('The unsubscribe link is invalid.', {
      code: ErrorCode.InvalidUnsubscribeToken,
      cause: options.cause,
    });
  }
}
