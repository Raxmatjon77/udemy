'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ErrorCode } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';

import { AuthCard } from '@/components/auth-card';
import { api } from '@/lib/api';
import { hasCode, problemMessage } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';
import { useFragmentToken } from '@/lib/use-fragment-token';

export function VerifyEmail() {
  const fragment = useFragmentToken();
  const queryClient = useQueryClient();
  const submitted = useRef(false);

  const verify = useMutation({
    mutationFn: (token: string) =>
      api('/auth/email/verify', { method: 'POST', json: { token }, quiet: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
  const { mutate } = verify;

  useEffect(() => {
    // The token is single-use: POST it exactly once, even under Strict Mode's double effects.
    if (fragment.status !== 'ready' || !fragment.token || submitted.current) return;
    submitted.current = true;
    mutate(fragment.token);
  }, [fragment, mutate]);

  const missing = fragment.status === 'ready' && !fragment.token;
  const invalid = missing || hasCode(verify.error, ErrorCode.InvalidToken);

  if (verify.isSuccess) {
    return (
      <AuthCard title="Email verified" description="Thanks! Your email address is confirmed.">
        <div role="status" className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            You can now apply to teach on Udemy, and later buy courses.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/become-instructor">Become an instructor</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/">Go to home</Link>
            </Button>
          </div>
        </div>
      </AuthCard>
    );
  }

  if (invalid) {
    return (
      <AuthCard
        title="This link does not work"
        description="The verification link is invalid, has expired or has already been used."
      >
        <div role="alert" className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Verification links are valid for 24 hours and work once. If your email is already
            verified there is nothing more to do; otherwise request a new link.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/verify-email/pending">Get a new link</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/">Go to home</Link>
            </Button>
          </div>
        </div>
      </AuthCard>
    );
  }

  if (verify.isError) {
    return (
      <AuthCard title="We could not verify your email">
        <div role="alert" className="grid gap-4">
          <p className="text-sm text-muted-foreground">{problemMessage(verify.error)}</p>
          <p className="text-sm text-muted-foreground">
            Open the link from the email again to retry.
          </p>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Verifying your email…">
      <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
        <Spinner />
        Please wait a moment.
      </div>
    </AuthCard>
  );
}
