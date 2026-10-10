import Link from 'next/link';
import { Button } from '@udemy/ui/components/button';

import { HeaderCart } from '@/components/commerce/header-cart';
import { getSession } from '@/lib/auth/session';

import { UserMenu, VerifyEmailBanner } from './user-menu';

/** Top bar: brand + the session state (server-rendered, so it never flashes "Log in"). */
export async function SiteHeader() {
  const session = await getSession();
  return (
    <header className="border-b bg-background print:hidden">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="rounded-sm text-lg font-semibold tracking-tight focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Udemy
          </Link>
          <nav aria-label="Catalog" className="flex items-center gap-4">
            <Link
              href="/courses"
              className="rounded-sm text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Courses
            </Link>
            {session ? (
              <Link
                href="/my-learning"
                className="rounded-sm text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                My learning
              </Link>
            ) : null}
          </nav>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <HeaderCart signedIn={session !== null} />
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
      </div>
      {session ? <VerifyEmailBanner /> : null}
    </header>
  );
}
