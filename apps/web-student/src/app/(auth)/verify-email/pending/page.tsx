import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@udemy/ui/components/button';

import { AuthCard } from '@/components/auth-card';
import { getSession } from '@/lib/auth/session';

import { ResendVerification } from '@/components/resend-verification';

export const metadata: Metadata = { title: 'Check your inbox' };

export default async function VerifyEmailPendingPage({
  searchParams,
}: PageProps<'/verify-email/pending'>) {
  const [session, { from }] = await Promise.all([getSession(), searchParams]);
  const fromSignup = from === 'signup';

  return (
    <AuthCard
      title="Check your inbox"
      description={
        fromSignup
          ? 'Your account is almost ready. We have sent a verification link to your email address.'
          : 'We send a verification link to the email address of your account.'
      }
    >
      <div className="grid gap-5 text-sm">
        <ol className="grid list-decimal gap-1 pl-5 text-muted-foreground">
          <li>Open the email from Udemy.</li>
          <li>Click “Verify my email”. The link is valid for 24 hours.</li>
          <li>Come back here and continue learning.</li>
        </ol>
        {session ? (
          <ResendVerification />
        ) : (
          <div className="grid gap-3">
            <p className="text-muted-foreground">
              {fromSignup
                ? 'You can log in already; some actions, like applying as an instructor, wait until the email is verified.'
                : 'Log in to request a new link.'}
            </p>
            <Button asChild>
              <Link href="/login?next=%2Fverify-email%2Fpending">Log in</Link>
            </Button>
          </div>
        )}
      </div>
    </AuthCard>
  );
}
