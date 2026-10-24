'use client';

import { useMutation } from '@tanstack/react-query';
import { ErrorCode, UnsubscribeRequestSchema } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { AuthCard } from '@/components/auth-card';
import { unsubscribe } from '@/lib/notifications/client';
import { hasCode, problemMessage } from '@/lib/problem';

/** Reads `#token=` (any opaque value the e-mail carried) and removes the fragment from the URL. */
export function takeUnsubscribeToken(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState' | 'state'>,
): string | null {
  const fragment = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const raw = fragment ? new URLSearchParams(fragment).get('token') : null;
  if (location.hash)
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  const parsed = UnsubscribeRequestSchema.shape.token.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type TokenState = { status: 'reading' } | { status: 'ready'; token: string | null };

/**
 * `/unsubscribe#token=…` (public; RFC 8058 one-click from the e-mail footer, design D14): the
 * token lives in the fragment (never sent to a server or logged), is POSTed exactly once, and
 * turns the e-mails of one category off.
 */
export function Unsubscribe() {
  const taken = useRef<string | null | undefined>(undefined);
  const submitted = useRef(false);
  const [state, setState] = useState<TokenState>({ status: 'reading' });
  const request = useMutation({ mutationFn: (token: string) => unsubscribe(token) });
  const { mutate } = request;

  useEffect(() => {
    if (taken.current === undefined)
      taken.current = takeUnsubscribeToken(window.location, window.history);
    setState({ status: 'ready', token: taken.current });
  }, []);

  useEffect(() => {
    if (state.status !== 'ready' || !state.token || submitted.current) return;
    submitted.current = true;
    mutate(state.token);
  }, [state, mutate]);

  if (request.isSuccess) {
    return (
      <AuthCard title="You are unsubscribed" description="You will no longer get these emails.">
        <div role="status" className="grid gap-4 text-sm text-muted-foreground">
          <p>Notifications in the app are not affected. You can change this any time.</p>
          <Button asChild variant="outline">
            <Link href="/account/notifications">Notification settings</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }
  const invalid =
    (state.status === 'ready' && !state.token) ||
    hasCode(request.error, ErrorCode.InvalidUnsubscribeToken);
  if (invalid) {
    return (
      <AuthCard title="This link does not work" description="The unsubscribe link is invalid.">
        <div role="alert" className="grid gap-4 text-sm text-muted-foreground">
          <p>Sign in to choose which emails you get.</p>
          <Button asChild variant="outline">
            <Link href="/account/notifications">Notification settings</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }
  if (request.isError) {
    return (
      <AuthCard title="Something went wrong" description="We could not unsubscribe you.">
        <div role="alert" className="grid gap-4 text-sm">
          <p>{problemMessage(request.error)}</p>
          <Button onClick={() => state.status === 'ready' && state.token && mutate(state.token)}>
            Try again
          </Button>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Unsubscribing…">
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" /> One moment.
      </p>
    </AuthCard>
  );
}
