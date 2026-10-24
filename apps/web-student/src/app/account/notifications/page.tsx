import type { Metadata } from 'next';

import { NotificationPreferencesForm } from '@/components/notifications/notification-preferences';

export const metadata: Metadata = { title: 'Notifications', robots: { index: false } };

/** `/account/notifications` (session required): which notifications arrive, and how. */
export default function NotificationsPage() {
  return (
    <section aria-labelledby="notifications-title" className="flex flex-col gap-4">
      <div className="grid gap-1">
        <h1 id="notifications-title" className="text-2xl font-semibold tracking-tight">
          Notifications
        </h1>
        <p className="text-sm text-muted-foreground">
          Choose what you hear about in the app and by email.
        </p>
      </div>
      <NotificationPreferencesForm />
    </section>
  );
}
