import type { PreferenceOverride } from '../../domain/notification-preferences';

/**
 * `notifications.notification_preferences`: the stored overrides of the code defaults, per
 * (user, category, channel). Locked pairs are rejected before they reach it (design D14).
 */
export abstract class NotificationPreferenceRepository {
  abstract listOverrides(userId: string): Promise<PreferenceOverride[]>;

  /**
   * Upserts the overrides in one statement. Returns false (and writes nothing) when the user
   * does not exist (deleted account: `notification_preferences_user_id_fk`).
   */
  abstract upsert(userId: string, overrides: readonly PreferenceOverride[]): Promise<boolean>;
}
