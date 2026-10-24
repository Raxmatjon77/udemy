'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorCode, type ReviewBlockReason, type ReviewState } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@udemy/ui/components/dialog';
import { Label } from '@udemy/ui/components/label';
import { StarRating, StarRatingInput } from '@udemy/ui/components/star-rating';
import { Textarea } from '@udemy/ui/components/textarea';
import { useId, useState } from 'react';

import {
  deleteMyReview,
  engagementKeys,
  fetchMyCourseReview,
  upsertMyReview,
} from '@/lib/engagement/client';
import { problemMessage } from '@/lib/problem';

/**
 * "Leave a rating" (design D10, §10; decision P5-D8): enabled once the server says the learner
 * may review (`canReview`: an ACTIVE enrollment and at least one completed lecture, not the
 * owner). Otherwise the `blockReason` explains why. Plain-text body (≤ 2000), editable,
 * deletable; a hidden or suspended review shows its state.
 */

export const REVIEW_BLOCK_MESSAGES: Record<ReviewBlockReason, string> = {
  [ErrorCode.EnrollmentRequired]: 'Only enrolled students can rate this course.',
  [ErrorCode.CannotReviewOwnCourse]: 'You cannot rate your own course.',
  [ErrorCode.ReviewNotEligible]: 'Complete at least one lecture to leave a rating.',
};

const REVIEW_STATE_NOTES: Record<ReviewState, string | null> = {
  PUBLISHED: null,
  HIDDEN: 'Your review was hidden by our moderators and is not public.',
  SUSPENDED: 'Your review is not public while your enrollment is inactive.',
};

export function RatingButton({ courseId, disabled }: { courseId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const mine = useQuery({
    queryKey: engagementKeys.myReview(courseId),
    queryFn: ({ signal }) => fetchMyCourseReview(courseId, signal),
    enabled: !disabled,
  });
  const reviewed = mine.data?.review ?? null;
  const blocked = mine.data && !mine.data.canReview ? mine.data.blockReason : null;
  const hintId = useId();

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || !mine.data || (!mine.data.canReview && reviewed === null)}
        aria-describedby={blocked ? hintId : undefined}
        onClick={() => setOpen(true)}
      >
        {reviewed ? (
          <>
            <StarRating value={reviewed.rating} starClassName="size-3.5" />
            Edit your rating
          </>
        ) : (
          'Leave a rating'
        )}
      </Button>
      {blocked && reviewed === null ? (
        <p id={hintId} className="text-xs text-muted-foreground" data-testid="rating-blocked">
          {REVIEW_BLOCK_MESSAGES[blocked]}
        </p>
      ) : null}
      {mine.data ? (
        <RatingDialog
          key={reviewed?.id ?? 'new'}
          courseId={courseId}
          open={open}
          onOpenChange={setOpen}
          initialRating={reviewed?.rating ?? null}
          initialBody={reviewed?.body ?? ''}
          state={reviewed?.state ?? null}
          exists={reviewed !== null}
        />
      ) : null}
    </div>
  );
}

function RatingDialog({
  courseId,
  open,
  onOpenChange,
  initialRating,
  initialBody,
  state,
  exists,
}: {
  courseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialRating: number | null;
  initialBody: string;
  state: ReviewState | null;
  exists: boolean;
}) {
  const queryClient = useQueryClient();
  const [rating, setRating] = useState<number | null>(initialRating);
  const [body, setBody] = useState(initialBody);
  const bodyId = useId();
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: engagementKeys.myReview(courseId) });
    void queryClient.invalidateQueries({ queryKey: ['engagement', 'reviews', courseId] });
    onOpenChange(false);
  };
  const save = useMutation({
    mutationFn: () =>
      upsertMyReview(courseId, { rating: rating!, body: body.trim() ? body.trim() : null }),
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => deleteMyReview(courseId), onSuccess: done });
  const error = save.error ?? remove.error;
  const note = state ? REVIEW_STATE_NOTES[state] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{exists ? 'Edit your rating' : 'Rate this course'}</DialogTitle>
          <DialogDescription>
            Your rating and review are public, shown with your name.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (rating !== null) save.mutate();
          }}
        >
          {note ? (
            <p role="note" className="text-sm text-muted-foreground">
              {note}
            </p>
          ) : null}
          <StarRatingInput legend="Your rating" value={rating} onChange={setRating} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={bodyId}>Your review (optional)</Label>
            <Textarea
              id={bodyId}
              value={body}
              rows={4}
              maxLength={2000}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {problemMessage(error, REVIEW_BLOCK_MESSAGES)}
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            {exists ? (
              <Button
                type="button"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete review
              </Button>
            ) : null}
            <Button type="submit" disabled={rating === null || save.isPending}>
              {exists ? 'Save changes' : 'Submit rating'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
