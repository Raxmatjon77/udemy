import type { ReactNode } from 'react';

import { AccountNav } from './account-nav';

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto grid w-full max-w-5xl gap-8 px-6 py-10 md:grid-cols-[12rem_1fr]">
      <div className="grid content-start gap-4 print:hidden">
        <p className="text-sm font-medium text-muted-foreground">Account settings</p>
        <AccountNav />
      </div>
      <div className="min-w-0">{children}</div>
    </main>
  );
}
