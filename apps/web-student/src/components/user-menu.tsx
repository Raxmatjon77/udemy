'use client';

import Link from 'next/link';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Skeleton } from '@udemy/ui/components/skeleton';

import { useMe } from '@/lib/queries';

import { LogoutButton } from './logout-button';

/** The signed-in part of the header. */
export function UserMenu({ isInstructor }: { isInstructor: boolean }) {
  const me = useMe({ quiet: true });
  const name = me.data?.displayName;

  return (
    <nav aria-label="Account" className="flex items-center gap-1 sm:gap-2">
      {!isInstructor ? (
        <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
          <Link href="/become-instructor">Teach on Udemy</Link>
        </Button>
      ) : null}
      <Button asChild variant="ghost" size="sm">
        <Link href="/account/profile">
          {me.isPending ? (
            <>
              <Skeleton className="h-4 w-20" />
              <span className="sr-only">My account</span>
            </>
          ) : (
            <span className="max-w-40 truncate">{name ?? 'My account'}</span>
          )}
        </Link>
      </Button>
      <LogoutButton variant="outline" size="sm" />
    </nav>
  );
}

/** A reminder under the header while the email address is unverified. */
export function VerifyEmailBanner() {
  const me = useMe({ quiet: true });
  if (!me.data || me.data.emailVerified) return null;
  return (
    <Alert variant="warning" className="rounded-none border-x-0 border-t-0">
      <AlertDescription className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-2 px-2">
        <span>
          Please verify your email address (<strong>{me.data.email}</strong>) to apply as an
          instructor.
        </span>
        <Link href="/verify-email/pending" className="font-medium underline underline-offset-4">
          Resend the link
        </Link>
      </AlertDescription>
    </Alert>
  );
}
