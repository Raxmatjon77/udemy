'use client';

import { Skeleton } from '@udemy/ui/components/skeleton';

import { useMe } from '@/lib/queries';

import { LogoutButton } from './logout-button';

export function UserMenu() {
  const me = useMe({ quiet: true });
  return (
    <nav aria-label="Account" className="flex items-center gap-3">
      {me.isPending ? (
        <Skeleton className="h-4 w-24" />
      ) : me.data ? (
        <span className="max-w-48 truncate text-sm font-medium">{me.data.displayName}</span>
      ) : null}
      <LogoutButton variant="outline" size="sm" />
    </nav>
  );
}
