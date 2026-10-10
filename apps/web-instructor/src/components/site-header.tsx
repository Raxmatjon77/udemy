import Link from 'next/link';
import { Badge } from '@udemy/ui/components/badge';

import { getSession } from '@/lib/auth/session';

import { MainNav } from './main-nav';
import { UserMenu } from './user-menu';

export async function SiteHeader() {
  const session = await getSession();
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-sm text-lg font-semibold tracking-tight focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Udemy
            <Badge variant="secondary">Instructor</Badge>
          </Link>
          {session ? <MainNav /> : null}
        </div>
        {session ? <UserMenu /> : null}
      </div>
    </header>
  );
}
