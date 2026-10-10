'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  AdminUserDetailSchema,
  BanRecordSchema,
  BanUserRequestSchema,
  ErrorCode,
  UnbanUserRequestSchema,
  type AdminUserDetail,
  type BanRecord,
} from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@udemy/ui/components/card';
import { Skeleton } from '@udemy/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { QueryError } from '@/components/query-error';
import { ReasonDialog } from '@/components/reason-dialog';
import { api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { ACCOUNT_STATUS_LABEL, ROLE_LABEL } from '@/lib/labels';
import { hasCode } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

const UnbanFormSchema = z.object({
  reason: z
    .string()
    .transform((value) => (value.trim() === '' ? undefined : value))
    .pipe(UnbanUserRequestSchema.shape.reason),
});

/** The page shows an out-of-date state when one of these comes back: refetch it. */
const STALE_CODES = [ErrorCode.AlreadyBanned, ErrorCode.NotBanned, ErrorCode.TargetIsAdmin];

function BanActions({
  detail,
  currentUserId,
}: {
  detail: AdminUserDetail;
  currentUserId: string | null;
}) {
  const queryClient = useQueryClient();
  const { user } = detail;
  const path = `/admin/users/${encodeURIComponent(user.id)}`;

  const onSettled = () => queryClient.invalidateQueries({ queryKey: queryKeys.users });
  const onError = (error: unknown) => {
    if (STALE_CODES.some((code) => hasCode(error, code))) void onSettled();
  };
  const ban = useMutation({
    mutationFn: (reason: string) =>
      api(`${path}/ban`, { method: 'POST', json: { reason }, schema: BanRecordSchema }),
    onSuccess: onSettled,
    onError,
  });
  const unban = useMutation({
    mutationFn: (reason: string | undefined) =>
      api(`${path}/unban`, {
        method: 'POST',
        json: reason ? { reason } : {},
        schema: BanRecordSchema,
      }),
    onSuccess: onSettled,
    onError,
  });

  if (user.id === currentUserId) {
    return <p className="text-sm text-muted-foreground">This is your own account.</p>;
  }

  if (user.status === 'BANNED') {
    return (
      <ReasonDialog
        trigger={<Button variant="outline">Lift ban</Button>}
        title={`Lift the ban on ${user.displayName}?`}
        description="They can sign in again immediately."
        label="Reason"
        optional
        fieldDescription="Stored in the ban history."
        schema={UnbanFormSchema}
        confirmLabel="Lift ban"
        pendingLabel="Lifting…"
        onConfirm={(reason) => unban.mutateAsync(reason)}
      />
    );
  }

  if (detail.roles.includes('ADMIN')) {
    return (
      <p className="text-sm text-muted-foreground">
        Administrators cannot be banned. Revoke the admin role first.
      </p>
    );
  }

  return (
    <ReasonDialog
      trigger={<Button variant="destructive">Ban user</Button>}
      title={`Ban ${user.displayName}?`}
      description={`All ${detail.activeSessionCount} active session(s) end immediately and the user cannot sign in to any Udemy app until the ban is lifted.`}
      label="Reason"
      fieldDescription="10 to 1000 characters. Stored in the ban history and the audit trail."
      schema={BanUserRequestSchema}
      confirmLabel="Ban user"
      pendingLabel="Banning…"
      destructive
      onConfirm={(reason) => ban.mutateAsync(reason ?? '')}
    />
  );
}

function AdminLink({ id, currentUserId }: { id: string; currentUserId: string | null }) {
  if (id === currentUserId) return <>you</>;
  return (
    <Link href={`/users/${id}`} className="underline underline-offset-4">
      an administrator
    </Link>
  );
}

function BanHistory({ bans, currentUserId }: { bans: BanRecord[]; currentUserId: string | null }) {
  if (bans.length === 0) {
    return <p className="text-sm text-muted-foreground">This user has never been banned.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Banned</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>Lifted</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bans.map((ban) => (
          <TableRow key={ban.id} className="align-top">
            <TableCell className="whitespace-nowrap">
              <time dateTime={ban.bannedAt}>{formatDateTime(ban.bannedAt)}</time>
              <div className="text-xs text-muted-foreground">
                by <AdminLink id={ban.bannedBy} currentUserId={currentUserId} />
              </div>
            </TableCell>
            <TableCell className="max-w-md whitespace-pre-line">{ban.reason}</TableCell>
            <TableCell className="whitespace-nowrap">
              {ban.liftedAt ? (
                <>
                  <time dateTime={ban.liftedAt}>{formatDateTime(ban.liftedAt)}</time>
                  {ban.liftedBy ? (
                    <div className="text-xs text-muted-foreground">
                      by <AdminLink id={ban.liftedBy} currentUserId={currentUserId} />
                    </div>
                  ) : null}
                  {ban.liftReason ? (
                    <div className="max-w-xs text-xs whitespace-pre-line text-muted-foreground">
                      {ban.liftReason}
                    </div>
                  ) : null}
                </>
              ) : (
                <Badge variant="destructive">Active</Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function UserDetail({ id, currentUserId }: { id: string; currentUserId: string | null }) {
  const detail = useQuery({
    queryKey: queryKeys.user(id),
    queryFn: () => api(`/admin/users/${encodeURIComponent(id)}`, { schema: AdminUserDetailSchema }),
  });

  if (detail.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading user" className="grid gap-4">
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (!detail.data) {
    return <QueryError error={detail.error} onRetry={() => void detail.refetch()} />;
  }

  const { user, roles, bans, activeSessionCount } = detail.data;
  const banned = user.status === 'BANNED';

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
          {user.displayName}
          <Badge variant={banned ? 'destructive' : 'outline'}>
            {ACCOUNT_STATUS_LABEL[user.status]}
          </Badge>
        </h1>
        <p className="text-sm text-muted-foreground">{user.email}</p>
      </div>

      {banned ? (
        <Alert variant="destructive">
          <AlertDescription>
            This account is banned and cannot sign in. See the ban history below.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle asChild>
            <h2>Account</h2>
          </CardTitle>
          <CardDescription>
            Joined <time dateTime={user.createdAt}>{formatDate(user.createdAt)}</time>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-[12rem_1fr]">
            <dt className="font-medium">Email</dt>
            <dd className="text-muted-foreground">
              {user.emailVerified ? 'Verified' : 'Not verified'}
            </dd>
            <dt className="font-medium">Roles</dt>
            <dd className="flex flex-wrap gap-1">
              {roles.map((role) => (
                <Badge key={role} variant={role === 'STUDENT' ? 'outline' : 'secondary'}>
                  {ROLE_LABEL[role]}
                </Badge>
              ))}
            </dd>
            <dt className="font-medium">Active sessions</dt>
            <dd className="text-muted-foreground">{activeSessionCount}</dd>
            <dt className="font-medium">User id</dt>
            <dd className="font-mono text-xs break-all text-muted-foreground">{user.id}</dd>
          </dl>
        </CardContent>
        <CardFooter className="border-t pt-6">
          <BanActions detail={detail.data} currentUserId={currentUserId} />
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle asChild>
            <h2>Ban history</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <BanHistory bans={bans} currentUserId={currentUserId} />
        </CardContent>
      </Card>
    </div>
  );
}
