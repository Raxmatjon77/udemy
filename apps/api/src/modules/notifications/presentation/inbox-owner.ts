import { NOTIFICATION_APP_OF_CLIENT } from '@udemy/contracts';
import type { Principal } from '../../../shared/auth';
import type { InboxOwner } from '../application/ports/notification.repository';

/** The inbox of a principal: their own rows for the app they are signed in to (design D14). */
export function inboxOf(principal: Principal): InboxOwner {
  return { userId: principal.userId, app: NOTIFICATION_APP_OF_CLIENT[principal.app] };
}
