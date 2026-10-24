import { Injectable } from '@nestjs/common';
import {
  isPreferenceLocked,
  NOTIFICATION_CATEGORY_META,
  NOTIFICATION_CHANNELS,
  type NotificationCategory,
  type NotificationChannel,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';

/** Whether a notification of one category reaches the user in-app and by e-mail. */
export interface ChannelSwitches {
  readonly inApp: boolean;
  readonly email: boolean;
}

export interface PreferenceOverride {
  readonly channel: string;
  readonly enabled: boolean;
}

/**
 * Effective channels of one category (design D14, the api's `effectivePreferences`): the code
 * default of `NOTIFICATION_CATEGORY_META` ⊕ the stored override. A locked pair (MODERATION) is
 * always on, whatever a stray stored row says.
 */
export function effectiveChannels(
  category: NotificationCategory,
  overrides: readonly PreferenceOverride[],
): ChannelSwitches {
  const stored = new Map(overrides.map((o) => [o.channel, o.enabled]));
  const enabled = (channel: NotificationChannel): boolean =>
    isPreferenceLocked(category, channel) ||
    (stored.get(channel) ?? NOTIFICATION_CATEGORY_META[category].defaults[channel]);
  const [inApp, email] = NOTIFICATION_CHANNELS.map(enabled) as [boolean, boolean];
  return { inApp, email };
}

/**
 * Reads `notifications.notification_preferences` overrides in the handler's transaction
 * (primary-key range scans). A user without rows gets the code defaults.
 */
@Injectable()
export class NotificationPreferencesReader {
  async forUser(
    trx: Transaction<DB>,
    userId: string,
    category: NotificationCategory,
  ): Promise<ChannelSwitches> {
    const rows = await trx
      .selectFrom('notifications.notificationPreferences')
      .select(['channel', 'enabled'])
      .where('userId', '=', userId)
      .where('category', '=', category)
      .execute();
    return effectiveChannels(category, rows);
  }

  /** One query for a fan-out batch: every user of `userIds` gets an entry. */
  async forUsers(
    trx: Transaction<DB>,
    userIds: readonly string[],
    category: NotificationCategory,
  ): Promise<Map<string, ChannelSwitches>> {
    const byUser = new Map<string, PreferenceOverride[]>(userIds.map((id) => [id, []]));
    if (userIds.length > 0) {
      const rows = await trx
        .selectFrom('notifications.notificationPreferences')
        .select(['userId', 'channel', 'enabled'])
        .where('userId', 'in', [...userIds])
        .where('category', '=', category)
        .execute();
      for (const row of rows) byUser.get(row.userId)?.push(row);
    }
    return new Map(
      [...byUser].map(([id, overrides]) => [id, effectiveChannels(category, overrides)]),
    );
  }
}
