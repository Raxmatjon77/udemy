'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  InstructorApplicationSchema,
  MyInstructorApplicationsResponseSchema,
  type InstructorApplication,
} from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
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
import { Spinner } from '@udemy/ui/components/spinner';

import { ResendVerification } from '@/components/resend-verification';
import { api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { hasCode, problemMessage } from '@/lib/problem';
import { queryKeys, useMe } from '@/lib/queries';

import { ApplicationForm } from './application-form';
import { EXPERIENCE_LABEL, STATUS_BADGE, STATUS_LABEL } from './labels';

export function useMyApplications() {
  return useQuery({
    queryKey: queryKeys.myApplications,
    queryFn: () =>
      api('/me/instructor-applications', { schema: MyInstructorApplicationsResponseSchema }),
    select: (data) => data.items,
  });
}

function PendingApplication({ application }: { application: InstructorApplication }) {
  const queryClient = useQueryClient();
  const withdraw = useMutation({
    mutationFn: () =>
      api(`/me/instructor-applications/${encodeURIComponent(application.id)}/withdraw`, {
        method: 'POST',
        schema: InstructorApplicationSchema,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.myApplications }),
  });
  const stale = hasCode(withdraw.error, ErrorCode.InvalidStateTransition);

  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2 className="flex items-center gap-2">
            Your application is under review
            <Badge variant="secondary">{STATUS_LABEL.PENDING}</Badge>
          </h2>
        </CardTitle>
        <CardDescription>
          Submitted on{' '}
          <time dateTime={application.submittedAt}>{formatDate(application.submittedAt)}</time>. We
          will email you as soon as it has been reviewed.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div role="alert" aria-live="assertive">
          {withdraw.isError && !stale ? (
            <Alert variant="destructive">
              <AlertDescription>{problemMessage(withdraw.error)}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="font-medium">Expertise</dt>
          <dd className="text-muted-foreground">{application.expertise}</dd>
          <dt className="font-medium">Teaching experience</dt>
          <dd className="text-muted-foreground">{EXPERIENCE_LABEL[application.experienceLevel]}</dd>
        </dl>
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={() => withdraw.mutate()} disabled={withdraw.isPending}>
          {withdraw.isPending ? <Spinner /> : null}
          {withdraw.isPending ? 'Withdrawing…' : 'Withdraw application'}
        </Button>
      </CardFooter>
    </Card>
  );
}

function History({ applications }: { applications: InstructorApplication[] }) {
  if (applications.length === 0) return null;
  return (
    <section aria-labelledby="history-title" className="grid gap-4">
      <h2 id="history-title" className="text-lg font-semibold tracking-tight">
        Application history
      </h2>
      <ol className="grid gap-4">
        {applications.map((application) => {
          const decision = [...application.transitions]
            .reverse()
            .find((t) => t.toStatus === 'REJECTED' && t.reason);
          return (
            <li key={application.id}>
              <Card className="gap-3 py-4">
                <CardHeader className="px-4">
                  <CardTitle asChild>
                    <h3 className="flex flex-wrap items-center gap-2 text-base">
                      Application of{' '}
                      <time dateTime={application.submittedAt}>
                        {formatDate(application.submittedAt)}
                      </time>
                      <Badge variant={STATUS_BADGE[application.status]}>
                        {STATUS_LABEL[application.status]}
                      </Badge>
                    </h3>
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 px-4 text-sm">
                  {decision ? (
                    <p>
                      <span className="font-medium">Reviewer’s note:</span>{' '}
                      <span className="whitespace-pre-line text-muted-foreground">
                        {decision.reason}
                      </span>
                    </p>
                  ) : null}
                  <ol className="grid gap-1 border-l pl-4 text-muted-foreground">
                    {application.transitions.map((transition) => (
                      <li key={`${transition.toStatus}-${transition.occurredAt}`}>
                        {transition.fromStatus === null
                          ? 'Submitted'
                          : STATUS_LABEL[transition.toStatus]}{' '}
                        on{' '}
                        <time dateTime={transition.occurredAt}>
                          {formatDateTime(transition.occurredAt)}
                        </time>
                      </li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function BecomeInstructor() {
  const me = useMe();
  const applications = useMyApplications();

  if (me.isPending || applications.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading" className="grid gap-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const failed = me.error ?? applications.error;
  if (failed) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {problemMessage(failed)}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void me.refetch();
              void applications.refetch();
            }}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const items = applications.data ?? [];
  const pending = items.find((application) => application.status === 'PENDING');
  const past = items.filter((application) => application !== pending);
  const isInstructor = me.data?.roles.includes('INSTRUCTOR') ?? false;

  let main;
  if (isInstructor) {
    main = (
      <Alert variant="success" role="status">
        <AlertTitle>You are an instructor</AlertTitle>
        <AlertDescription>
          Sign in to the instructor app with this account to create your first course.
        </AlertDescription>
      </Alert>
    );
  } else if (pending) {
    main = <PendingApplication application={pending} />;
  } else if (me.data && !me.data.emailVerified) {
    main = (
      <Card>
        <CardHeader>
          <CardTitle asChild>
            <h2>Verify your email first</h2>
          </CardTitle>
          <CardDescription>
            To apply, we need to know we can reach you. We sent a verification link to{' '}
            <strong>{me.data.email}</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResendVerification />
        </CardContent>
      </Card>
    );
  } else {
    main = (
      <Card>
        <CardHeader>
          <CardTitle asChild>
            <h2>{past.length > 0 ? 'Apply again' : 'Your application'}</h2>
          </CardTitle>
          <CardDescription>
            All fields except the portfolio link are required.{' '}
            <Link href="/account/profile" className="underline underline-offset-4">
              Complete your profile
            </Link>{' '}
            too: reviewers look at it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApplicationForm />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-10">
      {main}
      <History applications={past} />
    </div>
  );
}
