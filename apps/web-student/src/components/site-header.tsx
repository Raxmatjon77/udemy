import Link from 'next/link';
import { Button } from '@udemy/ui/components/button';

import { getSession } from '@/lib/auth/session';

import { UserMenu, VerifyEmailBanner } from './user-menu';

/** Top bar: brand + the session state (server-rendered, so it never flashes "Log in"). */
export async function SiteHeader() {
  const session = await getSession();
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-6">
        <Link
          href="/"
          className="rounded-sm text-lg font-semibold tracking-tight focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Udemy
        </Link>
        {session ? (
          <UserMenu isInstructor={session.roles.includes('INSTRUCTOR')} />
        ) : (
          <nav aria-label="Account" className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">Log in</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/signup">Sign up</Link>
            </Button>
          </nav>
        )}
      </div>
      {session ? <VerifyEmailBanner /> : null}
    </header>
  );
}
