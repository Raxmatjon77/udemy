import type { ReactNode } from 'react';

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <main className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-10">{children}</main>;
}
