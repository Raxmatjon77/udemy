import { Injectable } from '@nestjs/common';
import type {
  NotificationPreferences,
  UpdateNotificationPreferencesRequest,
} from '@udemy/contracts';
import { effectivePreferences, lockedPairsOf } from '../../domain/notification-preferences';
import { PreferenceLocked } from '../../domain/notifications.errors';
import { NotificationPreferenceRepository } from '../ports/notification-preference.repository';

export interface UpdateNotificationPreferencesInput {
  readonly userId: string;
  readonly items: UpdateNotificationPreferencesRequest['items'];
}

/**
 * `UpdatePreferences` (design §5): a partial update; only the listed pairs change, each stored
 * as an override (one upsert). All or nothing: a request touching a locked (transactional)
 * pair changes nothing.
 *
 * Errors: 422 `preference_locked`.
 */
@Injectable()
export class UpdateNotificationPreferencesCommand {
  constructor(private readonly preferences: NotificationPreferenceRepository) {}

  async execute(input: UpdateNotificationPreferencesInput): Promise<NotificationPreferences> {
    const locked = lockedPairsOf(input.items);
    if (locked.length > 0) throw new PreferenceLocked(locked);
    await this.preferences.upsert(input.userId, input.items);
    return { items: effectivePreferences(await this.preferences.listOverrides(input.userId)) };
  }
}
