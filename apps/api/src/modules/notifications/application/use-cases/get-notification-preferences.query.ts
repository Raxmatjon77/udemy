import { Injectable } from '@nestjs/common';
import type { NotificationPreferences } from '@udemy/contracts';
import { effectivePreferences } from '../../domain/notification-preferences';
import { NotificationPreferenceRepository } from '../ports/notification-preference.repository';

/** `GetPreferences` (design §5): code defaults ⊕ the user's stored overrides, all 12 pairs. */
@Injectable()
export class GetNotificationPreferencesQuery {
  constructor(private readonly preferences: NotificationPreferenceRepository) {}

  async execute(userId: string): Promise<NotificationPreferences> {
    return { items: effectivePreferences(await this.preferences.listOverrides(userId)) };
  }
}
