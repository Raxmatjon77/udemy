'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CourseNotReadyProblemSchema,
  ErrorCode,
  SubmitNoteSchema,
  type CourseDetail,
  type Curriculum,
} from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import { Textarea } from '@udemy/ui/components/textarea';

import { CourseBadge } from '@/components/course-badge';
import { QueryError } from '@/components/query-error';
import { SubmitButton } from '@/components/submit-button';
import { catalogApi } from '@/lib/catalog-api';
import { catalogKeys, useCourseHistory } from '@/lib/catalog-queries';
import { formatDateTime } from '@/lib/format';
import { COURSE_STATUS_LABELS, TRANSITION_LABELS, type BuilderTarget } from '@/lib/labels';
import { isApiError, problemMessage } from '@/lib/problem';
import { friendlyZodError } from '@/lib/zod-messages';

import { ReadinessPanel } from './readiness-panel';

/**
 * Review tab (design §10): current state, the latest decision (a rejection reason is shown
 * prominently), the readiness checklist, Submit (optional note to the reviewer), Withdraw and
 * the status history.
 */
export function ReviewTab({
  course,
  curriculum,
  onNavigate,
  onWithdraw,
  withdrawing,
  withdrawError,
}: {
  course: CourseDetail;
  curriculum: Curriculum | undefined;
  onNavigate: (target: BuilderTarget) => void;
  onWithdraw: () => void;
  withdrawing: boolean;
  withdrawError: string | null;
}) {
  const queryClient = useQueryClient();
  const history = useCourseHistory(course.id);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: (body: { note?: string }) => catalogApi.submit(course.id, body),
    onSuccess: (result) => {
      setNote('');
      setMessage(`Version ${result.revisionNo} was submitted for review.`);
      void queryClient.invalidateQueries({ queryKey: catalogKeys.course(course.id) });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.myCoursesAll });
    },
    onError: (error) => {
      setMessage(null);
      if (isApiError(error) && error.code === ErrorCode.CourseNotReady) {
        const parsed = CourseNotReadyProblemSchema.safeParse(error.problem);
        if (parsed.success) {
          // Show the server's verdict at once; the refetch below confirms it.
          queryClient.setQueryData<CourseDetail>(catalogKeys.course(course.id), (old) =>
            old ? { ...old, readiness: { ready: false, issues: parsed.data.issues } } : old,
          );
        }
      }
      void queryClient.invalidateQueries({ queryKey: catalogKeys.course(course.id), exact: true });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = note.trim();
    if (trimmed) {
      const parsed = SubmitNoteSchema.safeParse(trimmed, { error: friendlyZodError });
      if (!parsed.success) {
        setNoteError(parsed.error.issues[0]?.message ?? 'Invalid note');
        return;
      }
    }
    setNoteError(null);
    submit.mutate(trimmed ? { note: trimmed } : {});
  }

  const decision = course.latestDecision;
  const issues = course.readiness.issues;
  const isUpdate = course.liveRevision !== null;
  const noChanges = isUpdate && !course.hasUnpublishedChanges;
  const canSubmit =
    !course.locked && course.status !== 'ARCHIVED' && course.readiness.ready && !noChanges;

  return (
    <div className="grid gap-8">
      <section aria-labelledby="state-heading" className="grid gap-3">
        <h2 id="state-heading" className="text-xl font-semibold">
          Review and publishing
        </h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="font-medium">Status</dt>
          <dd className="flex items-center gap-2">
            <CourseBadge badge={course.badge} />
            <span className="text-muted-foreground">{COURSE_STATUS_LABELS[course.status]}</span>
          </dd>
          <dt className="font-medium">Live version</dt>
          <dd>
            {course.liveRevision
              ? `Version ${course.liveRevision.revisionNo}${course.firstPublishedAt ? `, first published ${formatDateTime(course.firstPublishedAt)}` : ''}`
              : 'Not published yet'}
          </dd>
          <dt className="font-medium">Waiting for review</dt>
          <dd>
            {course.pendingRevision
              ? `Version ${course.pendingRevision.revisionNo}, submitted ${formatDateTime(course.pendingRevision.submittedAt)}`
              : 'Nothing'}
          </dd>
          {isUpdate ? (
            <>
              <dt className="font-medium">Unpublished changes</dt>
              <dd>
                {course.hasUnpublishedChanges
                  ? 'Yes: submit them to update the live course.'
                  : 'None'}
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      {decision?.action === 'REJECT' ? (
        <Alert variant="destructive">
          <AlertTitle>Version {decision.revisionNo} was not approved</AlertTitle>
          <AlertDescription className="grid gap-1">
            <p className="font-medium">Reason from the moderator:</p>
            <p className="whitespace-pre-wrap">{decision.reason ?? 'No reason was given.'}</p>
            <p className="text-xs">Decided {formatDateTime(decision.decidedAt)}</p>
          </AlertDescription>
        </Alert>
      ) : decision?.action === 'APPROVE' ? (
        <Alert variant="success">
          <AlertTitle>Version {decision.revisionNo} was approved</AlertTitle>
          <AlertDescription>
            {decision.reason ? <p className="whitespace-pre-wrap">{decision.reason}</p> : null}
            <p className="text-xs">Decided {formatDateTime(decision.decidedAt)}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {course.locked ? null : (
        <ReadinessPanel issues={issues} curriculum={curriculum} onNavigate={onNavigate} />
      )}

      {course.locked ? (
        <section aria-labelledby="withdraw-heading" className="grid gap-2">
          <h3 id="withdraw-heading" className="text-base font-semibold">
            Waiting for a moderator
          </h3>
          <p className="text-sm text-muted-foreground">
            The course is read-only until the review is decided. Withdraw it to make changes.
          </p>
          {withdrawError ? (
            <p role="alert" className="text-sm text-destructive">
              {withdrawError}
            </p>
          ) : null}
          <div>
            <Button type="button" variant="outline" onClick={onWithdraw} disabled={withdrawing}>
              {withdrawing ? (
                <>
                  <Spinner /> Withdrawing…
                </>
              ) : (
                'Withdraw from review'
              )}
            </Button>
          </div>
        </section>
      ) : course.status === 'ARCHIVED' ? null : (
        <form
          onSubmit={onSubmit}
          noValidate
          className="grid gap-3"
          aria-labelledby="submit-heading"
        >
          <h3 id="submit-heading" className="text-base font-semibold">
            {isUpdate ? 'Submit your changes for review' : 'Submit for review'}
          </h3>
          <p className="text-sm text-muted-foreground">
            A moderator checks the course before it goes live
            {isUpdate ? '; the live version stays unchanged until then' : ''}. While it waits, the
            course is read-only.
          </p>
          <div className="grid gap-2">
            <label htmlFor="submit-note" className="text-sm font-medium">
              Note to the reviewer{' '}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="submit-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={1000}
              rows={3}
              aria-invalid={Boolean(noteError)}
              aria-describedby={noteError ? 'submit-note-error' : undefined}
            />
            {noteError ? (
              <p id="submit-note-error" className="text-sm text-destructive">
                {noteError}
              </p>
            ) : null}
          </div>
          <div role="alert" aria-live="assertive">
            {submit.isError ? (
              <p className="text-sm text-destructive">{problemMessage(submit.error)}</p>
            ) : null}
          </div>
          <p role="status" aria-live="polite" className="text-sm">
            {message}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton
              pending={submit.isPending}
              pendingLabel="Submitting…"
              disabled={!canSubmit}
            >
              Submit for review
            </SubmitButton>
            {!course.readiness.ready ? (
              <span className="text-sm text-muted-foreground">Fix the items above first.</span>
            ) : noChanges ? (
              <span className="text-sm text-muted-foreground">
                No changes since the live version.
              </span>
            ) : null}
          </div>
        </form>
      )}

      <section aria-labelledby="history-heading" className="grid gap-3">
        <h3 id="history-heading" className="text-base font-semibold">
          History
        </h3>
        {history.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : history.isError ? (
          <QueryError error={history.error} onRetry={() => void history.refetch()} />
        ) : history.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No history yet.</p>
        ) : (
          <ol className="grid gap-3 border-l pl-4">
            {[...history.data.items].reverse().map((item) => (
              <li key={item.id} className="grid gap-0.5 text-sm">
                <p>
                  <span className="font-medium">{TRANSITION_LABELS[item.action]}</span>
                  {item.revisionNo !== null ? ` · version ${item.revisionNo}` : null}
                  {' · '}
                  <span className="text-muted-foreground">
                    {item.actor.isModerator ? 'Moderator' : item.actor.displayName}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt)}</time>
                </p>
                {item.reason ? (
                  <p className="whitespace-pre-wrap text-muted-foreground">{item.reason}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
