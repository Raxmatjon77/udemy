'use client';

import { useMutation } from '@tanstack/react-query';
import {
  ErrorCode,
  REPORT_REASON_LABELS,
  REPORT_REASONS,
  type ReportReason,
  type ReportSubjectType,
} from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@udemy/ui/components/dialog';
import { Label } from '@udemy/ui/components/label';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { Textarea } from '@udemy/ui/components/textarea';
import { useId, useState } from 'react';

import { reportContent } from '@/lib/engagement/client';
import { problemMessage } from '@/lib/problem';

const SUBJECT_LABELS: Record<ReportSubjectType, string> = {
  REVIEW: 'review',
  REVIEW_REPLY: 'reply',
  QUESTION: 'question',
  ANSWER: 'answer',
};

/** "Report" → reason + optional comment → `POST /engagement/{type}/:id/reports` (design D13). */
export function ReportButton({ type, subjectId }: { type: ReportSubjectType; subjectId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>('SPAM');
  const [comment, setComment] = useState('');
  const reasonId = useId();
  const commentId = useId();
  const report = useMutation({
    mutationFn: () =>
      reportContent(type, subjectId, {
        reason,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      }),
  });
  const label = SUBJECT_LABELS[type];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) report.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="ghost" aria-label={`Report this ${label}`}>
          Report
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report this {label}</DialogTitle>
          <DialogDescription>
            Our moderators review every report. Content reported by several people is hidden until
            they decide.
          </DialogDescription>
        </DialogHeader>
        {report.isSuccess ? (
          <p role="status" className="text-sm">
            Thanks, we received your report.
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              report.mutate();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={reasonId}>Reason</Label>
              <NativeSelect
                id={reasonId}
                value={reason}
                onChange={(event) => setReason(event.target.value as ReportReason)}
              >
                {REPORT_REASONS.map((value) => (
                  <option key={value} value={value}>
                    {REPORT_REASON_LABELS[value]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={commentId}>Details (optional)</Label>
              <Textarea
                id={commentId}
                value={comment}
                maxLength={500}
                rows={3}
                onChange={(event) => setComment(event.target.value)}
              />
            </div>
            {report.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {problemMessage(report.error, {
                  [ErrorCode.CannotReportOwnContent]: 'You cannot report your own content.',
                })}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={report.isPending}>
                Send report
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
