'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AdminCertificateReasonRequestSchema,
  AdminCertificateSchema,
  AdminUserCertificatesSchema,
  ErrorCode,
  type AdminCertificate,
  type CertificateTransitionAction,
  type CertificateTransitionCause,
} from '@udemy/contracts';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { QueryError } from '@/components/query-error';
import { ReasonDialog } from '@/components/reason-dialog';
import { TableSkeleton } from '@/components/table-skeleton';
import { api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { hasCode, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

/*
 * The "Certificates" tab of the user page (Phase 5 design D7, §8 admin, §10 web-admin): every
 * certificate of the user with its transition log, and admin revoke / reinstate with a reason.
 * An admin revocation sticks: a later enrollment regrant does not reinstate it (only an admin can).
 */

const TRANSITION_ACTION_LABEL: Record<CertificateTransitionAction, string> = {
  ISSUE: 'Issued',
  REVOKE: 'Revoked',
  REINSTATE: 'Reinstated',
};

const TRANSITION_CAUSE_LABEL: Record<CertificateTransitionCause, string> = {
  COURSE_COMPLETED: 'Course completed',
  ENROLLMENT_REVOKED: 'Enrollment revoked',
  ENROLLMENT_REGRANTED: 'Enrollment re-granted',
  ADMIN: 'By an admin',
};

const ACTION_MESSAGES: MessageOverrides = {
  [ErrorCode.InvalidStateTransition]:
    'This certificate was already changed. The list was refreshed.',
  [ErrorCode.CertificateNotFound]: 'This certificate no longer exists. The list was refreshed.',
};

function History({ entry }: { entry: AdminCertificate }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-1">
      <Button
        size="sm"
        variant="ghost"
        className="w-fit px-0"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        History ({entry.transitions.length})
      </Button>
      {open ? (
        <ol className="grid gap-1 text-xs">
          {entry.transitions.map((t) => (
            <li key={t.id}>
              <span className="font-medium">{TRANSITION_ACTION_LABEL[t.action]}</span> (
              {TRANSITION_CAUSE_LABEL[t.cause].toLowerCase()}
              {t.actor ? `, ${t.actor.displayName}` : ''}) ·{' '}
              <time dateTime={t.occurredAt}>{formatDateTime(t.occurredAt)}</time>
              {t.reason ? (
                <span className="block whitespace-pre-line text-muted-foreground">{t.reason}</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function Actions({
  entry,
  userName,
  onDone,
}: {
  entry: AdminCertificate;
  userName: string;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const { certificate } = entry;
  const transition = useMutation({
    mutationFn: ({ action, reason }: { action: 'revoke' | 'reinstate'; reason: string }) =>
      api(`/admin/certificates/${encodeURIComponent(certificate.id)}/${action}`, {
        method: 'POST',
        json: { reason },
        schema: AdminCertificateSchema,
      }),
    onSuccess: (_updated, { action }) => {
      onDone(
        `${action === 'revoke' ? 'Revoked' : 'Reinstated'} the certificate for ${certificate.courseTitle}.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.userCertificates(entry.userId) });
    },
    onError: (error) => {
      if (
        hasCode(error, ErrorCode.InvalidStateTransition) ||
        hasCode(error, ErrorCode.CertificateNotFound)
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.userCertificates(entry.userId) });
      }
    },
  });
  const common = {
    label: 'Reason',
    fieldDescription: '10 to 2000 characters. Stored in the certificate history.',
    schema: AdminCertificateReasonRequestSchema,
    maxLength: 2000,
    messages: ACTION_MESSAGES,
  };

  if (certificate.status === 'ACTIVE') {
    return (
      <ReasonDialog
        {...common}
        trigger={
          <Button
            size="sm"
            variant="destructive"
            aria-label={`Revoke certificate: ${certificate.courseTitle}`}
          >
            Revoke
          </Button>
        }
        title={`Revoke ${userName}'s certificate?`}
        description={`The certificate for ${certificate.courseTitle} shows as revoked on its public verification page and its PDF stops being served. An admin revocation sticks: re-enrolling the student does not reinstate it; only an admin can.`}
        confirmLabel="Revoke certificate"
        pendingLabel="Revoking…"
        destructive
        onConfirm={(reason) => transition.mutateAsync({ action: 'revoke', reason: reason ?? '' })}
      />
    );
  }
  return (
    <ReasonDialog
      {...common}
      trigger={
        <Button
          size="sm"
          variant="outline"
          aria-label={`Reinstate certificate: ${certificate.courseTitle}`}
        >
          Reinstate
        </Button>
      }
      title={`Reinstate ${userName}'s certificate?`}
      description={`The certificate for ${certificate.courseTitle} becomes valid again on its public verification page.`}
      confirmLabel="Reinstate certificate"
      pendingLabel="Reinstating…"
      onConfirm={(reason) => transition.mutateAsync({ action: 'reinstate', reason: reason ?? '' })}
    />
  );
}

export function UserCertificates({ userId, userName }: { userId: string; userName: string }) {
  const [notice, setNotice] = useState('');
  const certificates = useQuery({
    queryKey: queryKeys.userCertificates(userId),
    queryFn: () =>
      api(`/admin/users/${encodeURIComponent(userId)}/certificates`, {
        schema: AdminUserCertificatesSchema,
      }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2>Certificates</h2>
        </CardTitle>
        <CardDescription>
          Issued automatically when the student completes a course. Revoked when the enrollment is
          revoked, and reinstated on a re-grant unless an admin revoked it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p role="status" aria-live="polite" className="text-sm">
          {notice}
        </p>
        {certificates.isPending ? (
          <TableSkeleton label="Loading certificates" />
        ) : certificates.isError ? (
          <QueryError error={certificates.error} onRetry={() => void certificates.refetch()} />
        ) : certificates.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">This user has no certificates.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>PDF</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {certificates.data.items.map((entry) => {
                const { certificate } = entry;
                return (
                  <TableRow key={certificate.id} className="align-top">
                    <TableCell className="grid gap-1">
                      <span className="font-medium">{certificate.courseTitle}</span>
                      <History entry={entry} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{certificate.code}</TableCell>
                    <TableCell>
                      <Badge variant={certificate.status === 'ACTIVE' ? 'outline' : 'destructive'}>
                        {certificate.status === 'ACTIVE' ? 'Active' : 'Revoked'}
                      </Badge>
                      {certificate.revokedAt ? (
                        <div className="text-xs text-muted-foreground">
                          since{' '}
                          <time dateTime={certificate.revokedAt}>
                            {formatDate(certificate.revokedAt)}
                          </time>
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <time dateTime={certificate.issuedAt}>
                        {formatDate(certificate.issuedAt)}
                      </time>
                    </TableCell>
                    <TableCell>{certificate.pdfReady ? 'Ready' : 'Rendering'}</TableCell>
                    <TableCell>
                      <Actions entry={entry} userName={userName} onDone={setNotice} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
