'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_META,
  NOTIFICATION_CHANNELS,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreference,
} from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Skeleton } from '@udemy/ui/components/skeleton';

import { fetchPreferences, notificationKeys, updatePreferences } from '@/lib/notifications/client';
import { problemMessage } from '@/lib/problem';

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  IN_APP: 'In the app',
  EMAIL: 'Email',
};

/** Categories this (student) app shows (`NOTIFICATION_CATEGORY_META[c].apps`). */
export const STUDENT_CATEGORIES = NOTIFICATION_CATEGORIES.filter((category) =>
  NOTIFICATION_CATEGORY_META[category].apps.includes('STUDENT'),
);

/**
 * Notification preferences (design D14, §10 `/account/notifications`): a category × channel
 * matrix of the effective values (code defaults ⊕ my overrides). Transactional pairs are locked
 * on. Each change is saved at once (`PUT` with just that pair).
 */
export function NotificationPreferencesForm() {
  const queryClient = useQueryClient();
  const preferences = useQuery({
    queryKey: notificationKeys.preferences,
    queryFn: ({ signal }) => fetchPreferences(signal),
  });
  const save = useMutation({
    mutationFn: (item: {
      category: NotificationCategory;
      channel: NotificationChannel;
      enabled: boolean;
    }) => updatePreferences({ items: [item] }),
    onSuccess: (next) => queryClient.setQueryData(notificationKeys.preferences, next),
  });

  if (preferences.isPending) {
    return <Skeleton className="h-64" aria-label="Loading preferences" />;
  }
  if (preferences.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{problemMessage(preferences.error)}</AlertDescription>
      </Alert>
    );
  }
  const byPair = new Map<string, NotificationPreference>(
    preferences.data.items.map((item) => [`${item.category}:${item.channel}`, item]),
  );

  return (
    <div className="flex flex-col gap-4">
      <table className="w-full text-sm">
        <caption className="sr-only">Notification preferences</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-2 font-medium">
              Category
            </th>
            {NOTIFICATION_CHANNELS.map((channel) => (
              <th key={channel} scope="col" className="w-28 py-2 text-center font-medium">
                {CHANNEL_LABELS[channel]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {STUDENT_CATEGORIES.map((category) => {
            const meta = NOTIFICATION_CATEGORY_META[category];
            return (
              <tr key={category} className="border-b">
                <th scope="row" className="py-3 text-left font-normal">
                  {meta.label}
                </th>
                {NOTIFICATION_CHANNELS.map((channel) => {
                  const pref = byPair.get(`${category}:${channel}`);
                  const enabled = pref?.enabled ?? meta.defaults[channel];
                  const locked = pref?.locked ?? meta.locked.includes(channel);
                  return (
                    <td key={channel} className="py-3 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${meta.label}: ${CHANNEL_LABELS[channel]}`}
                        checked={enabled}
                        disabled={locked || save.isPending}
                        title={locked ? 'Always on' : undefined}
                        onChange={(event) =>
                          save.mutate({ category, channel, enabled: event.target.checked })
                        }
                        className="size-4 accent-primary"
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">
        Moderation notices are always on. Every email also has a one-click unsubscribe link.
      </p>
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(save.error, {
            [ErrorCode.PreferenceLocked]: 'This notification cannot be turned off.',
          })}
        </p>
      ) : save.isSuccess ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved.
        </p>
      ) : null}
    </div>
  );
}
