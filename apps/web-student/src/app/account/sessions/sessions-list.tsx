'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  SessionListResponseSchema,
  type ClientApp,
  type SessionView,
} from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@udemy/ui/components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@udemy/ui/components/dialog';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import { logout } from '@udemy/web-auth/client';

import { LogoutButton } from '@/components/logout-button';
import { api } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { hasCode, problemMessage } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

const APP_LABEL: Record<ClientApp, string> = {
  student: 'Udemy',
  instructor: 'Instructor',
  admin: 'Admin',
};

function SessionRow({
  session,
  onRevoke,
  revoking,
}: {
  session: SessionView;
  onRevoke: (id: string) => void;
  revoking: boolean;
}) {
  const device = session.device ?? 'Unknown device';
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 py-4">
      <div className="grid gap-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {device}
          <Badge variant="outline">{APP_LABEL[session.app]}</Badge>
          {session.current ? <Badge>This device</Badge> : null}
        </p>
        <p className="text-sm text-muted-foreground">
          {session.ip} · Active{' '}
          <time dateTime={session.lastUsedAt} title={formatDateTime(session.lastUsedAt)}>
            {formatRelative(session.lastUsedAt)}
          </time>{' '}
          · Signed in <time dateTime={session.createdAt}>{formatDateTime(session.createdAt)}</time>
        </p>
      </div>
      {session.current ? (
        <LogoutButton variant="outline" size="sm">
          Log out
        </LogoutButton>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onRevoke(session.id)}
          disabled={revoking}
          aria-label={`Sign out ${device} (${session.ip})`}
        >
          {revoking ? <Spinner /> : null}
          {revoking ? 'Signing out…' : 'Sign out'}
        </Button>
      )}
    </li>
  );
}

function LogoutEverywhere() {
  const [open, setOpen] = useState(false);
  const all = useMutation({ mutationFn: () => logout({ all: true, loginPath: '/login' }) });

  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2>Sign out everywhere</h2>
        </CardTitle>
        <CardDescription>
          Ends every session, including this one, on all devices and apps. Use it if you think
          someone else has access to your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog open={open} onOpenChange={(next) => !all.isPending && setOpen(next)}>
          <Button variant="destructive" onClick={() => setOpen(true)}>
            Sign out of all devices
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Sign out of all devices?</DialogTitle>
              <DialogDescription>
                You will be signed out here too and will need to log in again.
              </DialogDescription>
            </DialogHeader>
            <div role="alert" aria-live="assertive">
              {all.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>{problemMessage(all.error)}</AlertDescription>
                </Alert>
              ) : null}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={all.isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                variant="destructive"
                disabled={all.isPending || all.isSuccess}
                onClick={() => all.mutate()}
              >
                {all.isPending ? <Spinner /> : null}
                {all.isPending ? 'Signing out…' : 'Sign out everywhere'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export function SessionsList() {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () => api('/auth/sessions', { schema: SessionListResponseSchema }),
    select: (data) =>
      // Current first, then most recently used.
      [...data.items].sort(
        (a, b) => Number(b.current) - Number(a.current) || b.lastUsedAt.localeCompare(a.lastUsedAt),
      ),
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
  });
  // 404 session_not_found: it ended in the meantime, which is what the user wanted.
  const revokeFailed = revoke.isError && !hasCode(revoke.error, ErrorCode.SessionNotFound);

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle asChild>
            <h2>Where you are signed in</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div role="alert" aria-live="assertive">
            {revokeFailed ? (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{problemMessage(revoke.error)}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          {sessions.isPending ? (
            <div aria-busy="true" aria-label="Loading sessions" className="grid gap-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : sessions.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription className="flex flex-wrap items-center gap-3">
                {problemMessage(sessions.error)}
                <Button size="sm" variant="outline" onClick={() => void sessions.refetch()}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <ul className="divide-y">
              {sessions.data.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  onRevoke={(id) => revoke.mutate(id)}
                  revoking={revoke.isPending && revoke.variables === session.id}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <LogoutEverywhere />
    </div>
  );
}
