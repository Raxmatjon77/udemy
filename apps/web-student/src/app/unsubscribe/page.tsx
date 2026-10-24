import type { Metadata } from 'next';

import { Unsubscribe } from '@/components/notifications/unsubscribe';

export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false } };

/**
 * `/unsubscribe#token=…` (public; `Referrer-Policy: no-referrer`, next.config.ts): the
 * one-click unsubscribe link of notification e-mails.
 */
export default function UnsubscribePage() {
  return (
    <main className="flex flex-1 items-start justify-center px-4 py-10">
      <Unsubscribe />
    </main>
  );
}
