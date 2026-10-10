'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ErrorCode } from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';

import { api } from '@/lib/api';
import { hasCode, isApiError, problemMessage, retryAfterSeconds } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

const COOLDOWN_S = 60;

/** `POST /auth/email/verification-requests`, with a cooldown so nobody hammers the button. */
export function ResendVerification() {
  const queryClient = useQueryClient();
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const resend = useMutation({
    mutationFn: () => api('/auth/email/verification-requests', { method: 'POST' }),
    onSuccess: () => setCooldown(COOLDOWN_S),
    onError: (error) => {
      if (hasCode(error, ErrorCode.EmailAlreadyVerified)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.me });
        return;
      }
      const wait = isApiError(error) ? retryAfterSeconds(error.retryAfter) : null;
      if (wait) setCooldown(Math.min(wait, 3600));
    },
  });

  const alreadyVerified = hasCode(resend.error, ErrorCode.EmailAlreadyVerified);

  return (
    <div className="grid gap-3">
      <div role="status" aria-live="polite" aria-atomic="true">
        {resend.isSuccess ? (
          <Alert variant="success">
            <AlertDescription>A new link is on its way. Check your inbox.</AlertDescription>
          </Alert>
        ) : null}
        {alreadyVerified ? (
          <Alert variant="success">
            <AlertDescription>
              Your email is already verified.{' '}
              <Link href="/become-instructor" className="font-medium underline underline-offset-4">
                Continue
              </Link>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true">
        {resend.isError && !alreadyVerified ? (
          <Alert variant="destructive">
            <AlertDescription>{problemMessage(resend.error)}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      {!alreadyVerified ? (
        <Button
          variant="outline"
          onClick={() => resend.mutate()}
          disabled={resend.isPending || cooldown > 0}
        >
          {resend.isPending ? <Spinner /> : null}
          {resend.isPending
            ? 'Sending…'
            : cooldown > 0
              ? `Resend available in ${cooldown}s`
              : 'Resend verification email'}
        </Button>
      ) : null}
    </div>
  );
}
