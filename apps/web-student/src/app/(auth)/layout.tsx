import type { ReactNode } from 'react';

/** Sign-in style pages: one centred card on a quiet background. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex flex-1 items-start justify-center bg-muted/40 px-4 py-12 sm:items-center">
      {children}
    </main>
  );
}
