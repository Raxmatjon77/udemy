'use client';

import type { CourseDetail } from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';

import { formatDateTime } from '@/lib/format';

/**
 * The working copy is read-only while a submission is pending (design D2, `course_in_review`),
 * and an archived course cannot be edited at all.
 */
export function LockBanner({
  course,
  onWithdraw,
  withdrawing,
  error,
}: {
  course: CourseDetail;
  onWithdraw: () => void;
  withdrawing: boolean;
  error: string | null;
}) {
  if (course.locked) {
    return (
      <Alert variant="info" role="status">
        <AlertTitle>Waiting for review: the course is read-only</AlertTitle>
        <AlertDescription className="grid gap-3">
          <p>
            {course.pendingRevision
              ? `Version ${course.pendingRevision.revisionNo} was submitted on ${formatDateTime(course.pendingRevision.submittedAt)}.`
              : 'A submission is pending.'}{' '}
            While a moderator reviews it, nothing can be changed. Withdraw the submission to edit
            again; you can resubmit at any time.
          </p>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          <div>
            <Button type="button" size="sm" variant="outline" onClick={onWithdraw} disabled={withdrawing}>
              {withdrawing ? (
                <>
                  <Spinner /> Withdrawing…
                </>
              ) : (
                'Withdraw to edit'
              )}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }
  if (course.status === 'ARCHIVED') {
    return (
      <Alert variant="warning" role="status">
        <AlertTitle>This course is archived</AlertTitle>
        <AlertDescription>
          Archived courses are hidden from students and cannot be edited.
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}
