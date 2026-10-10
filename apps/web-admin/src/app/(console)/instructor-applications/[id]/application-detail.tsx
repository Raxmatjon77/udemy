'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ApproveInstructorApplicationRequestSchema,
  ErrorCode,
  InstructorApplicationDetailSchema,
  InstructorApplicationSchema,
  RejectInstructorApplicationRequestSchema,
  type InstructorApplicationDetail,
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

import { QueryError } from '@/components/query-error';
import { ReasonDialog } from '@/components/reason-dialog';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { APPLICATION_STATUS_BADGE, APPLICATION_STATUS_LABEL, EXPERIENCE_LABEL } from '@/lib/labels';
import { hasCode, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

const RejectFormSchema = RejectInstructorApplicationRequestSchema.pick({ reason: true });
const ApproveFormSchema = z.object({
  reason: z
    .string()
    .transform((value) => (value.trim() === '' ? undefined : value))
    .pipe(ApproveInstructorApplicationRequestSchema.shape.note),
});

const DECISION_MESSAGES: MessageOverrides = {
  [ErrorCode.VersionConflict]:
    'Another administrator changed this application while you were reviewing it. The latest version is now shown; check it and decide again.',
  [ErrorCode.InvalidStateTransition]:
    'This application is no longer pending (it was decided or withdrawn). The latest version is now shown.',
};

/** True when the page's copy is out of date and must be refetched. */
const isStale = (error: unknown) =>
  hasCode(error, ErrorCode.VersionConflict) || hasCode(error, ErrorCode.InvalidStateTransition);

function Decision({
  application,
  currentUserId,
}: {
  application: InstructorApplicationDetail;
  currentUserId: string | null;
}) {
  const queryClient = useQueryClient();
  const detailKey = queryKeys.application(application.id);

  const decide = useMutation({
    mutationFn: ({ action, reason }: { action: 'approve' | 'reject'; reason?: string }) =>
      api(`/admin/instructor-applications/${encodeURIComponent(application.id)}/${action}`, {
        method: 'POST',
        // expectedVersion: a concurrent decision fails with 409 version_conflict instead of
        // silently overriding what the other administrator saw.
        json:
          action === 'approve'
            ? { note: reason, expectedVersion: application.version }
            : { reason, expectedVersion: application.version },
        schema: InstructorApplicationSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.applications }),
    onError: (error) => {
      if (isStale(error)) void queryClient.invalidateQueries({ queryKey: detailKey });
    },
  });

  if (application.applicantId === currentUserId) {
    return (
      <Alert variant="info">
        <AlertDescription>
          This is your own application. Another administrator has to decide on it.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-wrap gap-3">
      <ReasonDialog
        trigger={<Button>Approve</Button>}
        title="Approve this application?"
        description={`${application.applicant.displayName} gets the instructor role and can sign in to the instructor app.`}
        label="Note"
        optional
        fieldDescription="Stored in the application history."
        schema={ApproveFormSchema}
        confirmLabel="Approve application"
        pendingLabel="Approving…"
        onConfirm={(reason) =>
          decide.mutateAsync({ action: 'approve', ...(reason ? { reason } : {}) })
        }
        messages={DECISION_MESSAGES}
      />
      <ReasonDialog
        trigger={<Button variant="destructive">Reject</Button>}
        title="Reject this application?"
        description="The applicant is notified and can apply again later."
        label="Reason"
        fieldDescription="10 to 1000 characters. The applicant sees this reason, so be specific and kind."
        schema={RejectFormSchema}
        confirmLabel="Reject application"
        pendingLabel="Rejecting…"
        destructive
        onConfirm={(reason) =>
          decide.mutateAsync({ action: 'reject', ...(reason ? { reason } : {}) })
        }
        messages={DECISION_MESSAGES}
      />
    </div>
  );
}

function Timeline({ application }: { application: InstructorApplicationDetail }) {
  return (
    <ol className="grid gap-4 border-l pl-6">
      {application.transitions.map((transition) => {
        const byApplicant = transition.actorId === application.applicantId;
        return (
          <li
            key={`${transition.toStatus}-${transition.occurredAt}`}
            className="relative grid gap-1"
          >
            <span
              aria-hidden="true"
              className="absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full border-2 border-background bg-primary"
            />
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {transition.fromStatus === null
                ? 'Submitted'
                : APPLICATION_STATUS_LABEL[transition.toStatus]}
              <span className="font-normal text-muted-foreground">
                by{' '}
                {byApplicant ? (
                  'the applicant'
                ) : (
                  <Link
                    href={`/users/${transition.actorId}`}
                    className="underline underline-offset-4"
                  >
                    an administrator
                  </Link>
                )}{' '}
                ·{' '}
                <time dateTime={transition.occurredAt}>
                  {formatDateTime(transition.occurredAt)}
                </time>
              </span>
            </p>
            {transition.reason ? (
              <p className="text-sm whitespace-pre-line text-muted-foreground">
                {transition.reason}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function ApplicationDetail({
  id,
  currentUserId,
}: {
  id: string;
  currentUserId: string | null;
}) {
  const application = useQuery({
    queryKey: queryKeys.application(id),
    queryFn: () =>
      api(`/instructor-applications/${encodeURIComponent(id)}`, {
        schema: InstructorApplicationDetailSchema,
      }),
  });

  if (application.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading application" className="grid gap-4">
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!application.data) {
    return <QueryError error={application.error} onRetry={() => void application.refetch()} />;
  }

  const app = application.data;
  const { applicant } = app;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="grid content-start gap-6">
        <div className="grid gap-2">
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            {applicant.displayName}
            <Badge variant={APPLICATION_STATUS_BADGE[app.status]}>
              {APPLICATION_STATUS_LABEL[app.status]}
            </Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            Submitted <time dateTime={app.submittedAt}>{formatDateTime(app.submittedAt)}</time>
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle asChild>
              <h2>Application</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 text-sm">
              <div className="grid gap-1">
                <dt className="font-medium">Expertise</dt>
                <dd className="text-muted-foreground">{app.expertise}</dd>
              </div>
              <div className="grid gap-1">
                <dt className="font-medium">Teaching experience</dt>
                <dd className="text-muted-foreground">{EXPERIENCE_LABEL[app.experienceLevel]}</dd>
              </div>
              <div className="grid gap-1">
                <dt className="font-medium">Motivation</dt>
                <dd className="whitespace-pre-line text-muted-foreground">{app.motivation}</dd>
              </div>
              <div className="grid gap-1">
                <dt className="font-medium">Portfolio</dt>
                <dd className="text-muted-foreground">
                  {app.portfolioUrl ? (
                    <a
                      href={app.portfolioUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="break-all text-primary underline underline-offset-4"
                    >
                      {app.portfolioUrl}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    'None given'
                  )}
                </dd>
              </div>
            </dl>
          </CardContent>
          {app.status === 'PENDING' ? (
            <CardFooter className="border-t pt-6">
              <Decision application={app} currentUserId={currentUserId} />
            </CardFooter>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle asChild>
              <h2>History</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Timeline application={app} />
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle asChild>
            <h2>Applicant</h2>
          </CardTitle>
          <CardDescription>{applicant.email}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {applicant.emailVerified ? (
            <Badge variant="outline">Email verified</Badge>
          ) : (
            <Badge variant="destructive">Email not verified</Badge>
          )}
          {applicant.status === 'BANNED' ? <Badge variant="destructive">Banned</Badge> : null}
        </CardContent>
        <CardFooter>
          <Button asChild variant="outline" size="sm">
            <Link href={`/users/${applicant.id}`}>View user</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
