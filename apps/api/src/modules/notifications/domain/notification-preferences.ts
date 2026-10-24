import {
  isPreferenceLocked,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
  NOTIFICATION_CHANNELS,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreference,
} from '@udemy/contracts';

/** A stored override (`notifications.notification_preferences` row). */
export interface PreferenceOverride {
  readonly category: NotificationCategory;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
}

export interface PreferencePair {
  readonly category: NotificationCategory;
  readonly channel: NotificationChannel;
}

function key(category: NotificationCategory, channel: NotificationChannel): string {
  return `${category}:${channel}`;
}

/**
 * Effective preferences (design D14): the code default of `NOTIFICATION_CATEGORY_META` ⊕ the
 * stored override, for every (category, channel) pair in `NOTIFICATION_CATEGORIES` ×
 * `NOTIFICATION_CHANNELS` order. A locked pair is always enabled and always "default": a stray
 * stored row for it (written before it was locked) never turns it off.
 */
export function effectivePreferences(
  overrides: readonly PreferenceOverride[],
): NotificationPreference[] {
  const stored = new Map(overrides.map((o) => [key(o.category, o.channel), o.enabled]));
  return NOTIFICATION_CATEGORIES.flatMap((category) =>
    NOTIFICATION_CHANNELS.map((channel): NotificationPreference => {
      const locked = isPreferenceLocked(category, channel);
      const override = stored.get(key(category, channel));
      if (locked) return { category, channel, enabled: true, locked: true, isDefault: true };
      return {
        category,
        channel,
        enabled: override ?? NOTIFICATION_CATEGORY_META[category].defaults[channel],
        locked: false,
        isDefault: override === undefined,
      };
    }),
  );
}

/** The locked pairs among `items` (an update touching any of them is refused). */
export function lockedPairsOf(items: readonly PreferencePair[]): PreferencePair[] {
  return items.filter((i) => isPreferenceLocked(i.category, i.channel));
}
