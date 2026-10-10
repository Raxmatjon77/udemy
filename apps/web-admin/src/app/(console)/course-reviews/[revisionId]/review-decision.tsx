'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ApproveRevisionRequestSchema,
  CourseDetailSchema,
  ErrorCode,
  RejectRevisionRequestSchema,
  type RevisionReview,
} from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';

import { ReasonDialog } from '@/components/reason-dialog';
import { api } from '@/lib/api';
import { hasCode, problemMessage, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

const RejectFormSchema = RejectRevisionRequestSchema.pick({ reason: true });
const ApproveFormSchema = z.object({
  reason: z
    .string()
    .transform((value) => (value.trim() === '' ? undefined : value))
    .pipe(ApproveRevisionRequestSchema.shape.note),
});

export const DECISION_MESSAGES: MessageOverrides = {
  [ErrorCode.VersionConflict]:
    'The course changed while you were reviewing it (for example the instructor withdrew or resubmitted). Reload the revision and check it again.',
  [ErrorCode.InvalidStateTransition]:
    'This revision is no longer waiting for review: it was already decided, withdrawn or replaced. Reload the revision to see its current state.',
  [ErrorCode.SelfDecisionForbidden]:
    'You cannot approve or reject your own course. Another administrator has to review it.',
  [ErrorCode.NotFound]: 'This course or revision no longer exists.',
  [ErrorCode.CourseNotFound]: 'This course no longer exists.',
};

/** The page's copy is out of date: the decision was refused and a reload is needed. */
const isStale = (error: unknown) =>
  hasCode(error, ErrorCode.VersionConflict) || hasCode(error, ErrorCode.InvalidStateTransition);

type Decision = { action: 'approve'; note?: string } | { action: 'reject'; reason: string };

export function ReviewDecision({
  review,
  currentUserId,
}: {
  review: RevisionReview;
  currentUserId: string | null;
}) {
  const queryClient = useQueryClient();
  const { course, revision } = review;
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const decide = useMutation({
    mutationFn: (decision: Decision) =>
      api(
        `/admin/courses/${encodeURIComponent(course.id)}/revisions/${encodeURIComponent(revision.id)}/${decision.action}`,
        {
          method: 'POST',
          // expectedVersion: a concurrent change (withdraw + resubmit, another admin's decision)
          // fails with 409 instead of deciding on a copy this reviewer has not seen.
          json:
            decision.action === 'approve'
              ? { note: decision.note, expectedVersion: course.version }
              : { reason: decision.reason, expectedVersion: course.version },
          schema: CourseDetailSchema,
        },
      ),
    onSuccess: (_course, decision) => {
      setDone(
        decision.action === 'approve'
          ? 'Approved. This revision is now live for students.'
          : 'Rejected. The instructor was notified with your reason.',
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.courseReviews });
      void queryClient.invalidateQueries({ queryKey: queryKeys.courses });
    },
    onError: (error) => {
      if (isStale(error)) setStale(true);
    },
  });

  const reload = () => {
    setStale(false);
    decide.reset();
    void queryClient.invalidateQueries({ queryKey: queryKeys.courseReview(revision.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.courseReviewQueue });
  };

  const pending = revision.state === 'PENDING' && course.pendingRevisionId === revision.id;

  let body;
  if (done) {
    body = null;
  } else if (!pending) {
    body = (
      <Alert variant="info">
        <AlertDescription>This revision is not waiting for a decision.</AlertDescription>
      </Alert>
    );
  } else if (course.owner.id === currentUserId) {
    body = (
      <Alert variant="info">
        <AlertDescription>
          This is your own course. Another administrator has to review it.
        </AlertDescription>
      </Alert>
    );
  } else {
    // The buttons stay mounted while stale: the open dialog keeps showing why the decision was
    // refused, and closing it returns focus to its trigger.
    body = (
      <div className="flex flex-wrap gap-3">
        <ReasonDialog
          trigger={<Button>Approve</Button>}
          title="Approve this revision?"
          description={
            revision.kind === 'INITIAL'
              ? 'The course goes live in the catalog right away.'
              : 'This version replaces the live course for students right away.'
          }
          label="Note"
          optional
          fieldDescription="Stored in the course history and shown to the instructor."
          schema={ApproveFormSchema}
          maxLength={2000}
          confirmLabel="Approve and publish"
          pendingLabel="Approving…"
          onConfirm={(note) => decide.mutateAsync({ action: 'approve', ...(note ? { note } : {}) })}
          messages={DECISION_MESSAGES}
        />
        <ReasonDialog
          trigger={<Button variant="destructive">Reject</Button>}
          title="Reject this revision?"
          description={
            revision.kind === 'INITIAL'
              ? 'The course stays unpublished. The instructor can fix it and submit again.'
              : 'The live course stays as it is. The instructor can fix the update and submit again.'
          }
          label="Reason"
          fieldDescription="10 to 2000 characters. The instructor receives this by email, so say what to fix."
          schema={RejectFormSchema}
          maxLength={2000}
          confirmLabel="Reject revision"
          pendingLabel="Rejecting…"
          destructive
          onConfirm={(reason) => decide.mutateAsync({ action: 'reject', reason: reason ?? '' })}
          messages={DECISION_MESSAGES}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div role="status" aria-live="polite">
        {done ? (
          <Alert variant="success">
            <AlertDescription>{done}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      {stale && !done ? (
        <Alert variant="warning">
          <AlertDescription className="grid gap-2">
            <span>{problemMessage(decide.error, DECISION_MESSAGES)}</span>
            <span>Your decision was not saved.</span>
            <Button size="sm" variant="outline" className="w-fit" onClick={reload}>
              Reload revision
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {body}
    </div>
  );
}
