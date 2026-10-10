import type { Metadata } from 'next';

import { SessionsList } from './sessions-list';

export const metadata: Metadata = { title: 'Sessions & security' };

export default function SessionsPage() {
  return (
    <section aria-labelledby="sessions-title" className="grid gap-6">
      <div className="grid gap-1">
        <h1 id="sessions-title" className="text-2xl font-semibold tracking-tight">
          Sessions & security
        </h1>
        <p className="text-sm text-muted-foreground">
          Devices where you are signed in to Udemy. If you do not recognise one, sign it out.
        </p>
      </div>
      <SessionsList />
    </section>
  );
}
