import { Injectable } from '@nestjs/common';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  type NotificationCategory,
  type NotificationChannel,
} from '@udemy/contracts';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import type { PreferenceOverride } from '../domain/notification-preferences';
import { NotificationPreferenceRepository } from '../application/ports/notification-preference.repository';

const USER_FK = 'notification_preferences_user_id_fk';

function isUnknownUser(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23503' &&
    (error as { constraint?: unknown }).constraint === USER_FK
  );
}

function isCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

function isChannel(value: string): value is NotificationChannel {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

/**
 * `notifications.notification_preferences` (PK `(user_id, category, channel)`; the CHECKs
 * mirror the contracts enums). `updated_at` is maintained by `set_updated_at`.
 */
@Injectable()
export class KyselyNotificationPreferenceRepository extends NotificationPreferenceRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async listOverrides(userId: string): Promise<PreferenceOverride[]> {
    const rows = await this.db
      .selectFrom('notifications.notificationPreferences')
      .select(['category', 'channel', 'enabled'])
      .where('userId', '=', userId)
      .execute();
    return rows.flatMap((row): PreferenceOverride[] => {
      const { category, channel } = row;
      if (!isCategory(category) || !isChannel(channel)) return [];
      return [{ category, channel, enabled: row.enabled }];
    });
  }

  async upsert(userId: string, overrides: readonly PreferenceOverride[]): Promise<boolean> {
    // One row per pair (the last one wins): ON CONFLICT cannot touch a row twice per statement.
    const byPair = new Map(overrides.map((o) => [`${o.category}:${o.channel}`, o]));
    if (byPair.size === 0) return true;
    try {
      await this.db
        .insertInto('notifications.notificationPreferences')
        .values(
          [...byPair.values()].map((o) => ({
            userId,
            category: o.category,
            channel: o.channel,
            enabled: o.enabled,
          })),
        )
        .onConflict((oc) =>
          oc
            .columns(['userId', 'category', 'channel'])
            .doUpdateSet((eb) => ({ enabled: eb.ref('excluded.enabled') })),
        )
        .execute();
      return true;
    } catch (error) {
      if (isUnknownUser(error)) return false;
      throw error;
    }
  }
}
