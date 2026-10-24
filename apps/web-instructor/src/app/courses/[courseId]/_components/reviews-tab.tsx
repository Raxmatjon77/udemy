'use client';

import { useId, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ErrorCode,
  REVIEW_RATINGS,
  ReviewReplyBodySchema,
  type InstructorReview,
} from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Label } from '@udemy/ui/components/label';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Textarea } from '@udemy/ui/components/textarea';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { QueryError } from '@/components/query-error';
import { engagementApi, engagementKeys } from '@/lib/engagement-api';
import { formatDate } from '@/lib/format';
import { hasCode, problemMessage } from '@/lib/problem';
import { friendlyZodError } from '@/lib/zod-messages';

const MAX_REPLY = 2000;

/** "★★★★☆" for the eye, "Rated 4 out of 5" for screen readers. */
export function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden="true" className="tracking-tight text-amber-500">
        {'★'.repeat(rating)}
        <span className="text-muted-foreground">{'☆'.repeat(5 - rating)}</span>
      </span>
      <span className="sr-only">Rated {rating} out of 5</span>
    </span>
  );
}

/**
 * Student reviews of the course (Phase 5 design §10 "Course tabs: Reviews (reply)", D10/D11):
 * newest first, filter by rating, and one public reply per review (create, edit, delete).
 * Bodies are plain text (D22). Hidden (moderation) and suspended (enrollment revoked) reviews
 * are listed with their state; a suspended review cannot be replied to.
 */
export function ReviewsTab({ courseId }: { courseId: string }) {
  const [rating, setRating] = useState<number | undefined>(undefined);
  const reviews = useInfiniteQuery({
    queryKey: engagementKeys.reviews(courseId, rating),
    queryFn: ({ pageParam }) => engagementApi.reviews(courseId, { rating, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = reviews.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="reviews-heading" className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h2 id="reviews-heading" className="text-xl font-semibold">
            Student reviews
          </h2>
          <p className="text-sm text-muted-foreground">
            Your reply is public and shown under the review on the course page.
          </p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="reviews-rating">Rating</Label>
          <NativeSelect
            id="reviews-rating"
            value={rating === undefined ? '' : String(rating)}
            onChange={(event) =>
              setRating(event.target.value === '' ? undefined : Number(event.target.value))
            }
            className="w-40"
          >
            <option value="">All ratings</option>
            {[...REVIEW_RATINGS].reverse().map((value) => (
              <option key={value} value={value}>
                {value} star{value === 1 ? '' : 's'}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {reviews.isPending ? (
        <div aria-busy="true" aria-label="Loading reviews" className="grid gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : reviews.isError ? (
        <QueryError error={reviews.error} onRetry={() => void reviews.refetch()} />
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-muted-foreground">
          {rating === undefined
            ? 'No reviews yet. Students can rate the course once they completed a lecture.'
            : 'No reviews with this rating.'}
        </p>
      ) : (
        <ul className="grid gap-4" aria-label="Reviews">
          {items.map((review) => (
            <ReviewItem key={review.id} courseId={courseId} review={review} />
          ))}
        </ul>
      )}
      {reviews.hasNextPage ? (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={reviews.isFetchingNextPage}
            onClick={() => void reviews.fetchNextPage()}
          >
            {reviews.isFetchingNextPage ? 'Loading…' : 'Load more reviews'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ReviewItem({ courseId, review }: { courseId: string; review: InstructorReview }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const headingId = useId();
  const author = review.author?.displayName ?? 'Former student';
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: engagementKeys.reviewsAll(courseId) });
  const canReply = review.state !== 'SUSPENDED';

  return (
    <li aria-labelledby={headingId} className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Stars rating={review.rating} />
        <h3 id={headingId} className="font-medium">
          {author}
        </h3>
        <span className="text-xs text-muted-foreground">
          <time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time>
          {review.editedAt ? ' · edited' : null}
        </span>
        {review.state === 'HIDDEN' ? (
          <Badge variant="destructive">Hidden by moderation</Badge>
        ) : null}
        {review.state === 'SUSPENDED' ? (
          <Badge variant="secondary">Suspended: enrollment revoked</Badge>
        ) : null}
      </div>
      {review.body ? (
        <p className="text-sm whitespace-pre-line">{review.body}</p>
      ) : (
        <p className="text-sm text-muted-foreground">Rating only, no written review.</p>
      )}

      {editing ? (
        <ReplyForm
          courseId={courseId}
          review={review}
          onDone={() => {
            setEditing(false);
            void refresh();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : review.reply ? (
        <div className="grid gap-2 rounded-md border-l-4 border-primary/40 bg-muted/40 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Your reply</span>
            <time dateTime={review.reply.createdAt}>{formatDate(review.reply.createdAt)}</time>
            {review.reply.editedAt ? <span>· edited</span> : null}
            {review.reply.hidden ? <Badge variant="destructive">Hidden by moderation</Badge> : null}
          </div>
          <p className="text-sm whitespace-pre-line">{review.reply.body}</p>
          {canReply ? (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditing(true)}
                aria-label={`Edit your reply to ${author}`}
              >
                Edit reply
              </Button>
              <ConfirmDialog
                trigger={
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete your reply to ${author}`}
                  >
                    Delete reply
                  </Button>
                }
                title="Delete your reply?"
                description="The reply is removed from the course page. You can write a new one later."
                confirmLabel="Delete reply"
                pendingLabel="Deleting…"
                onConfirm={async () => {
                  try {
                    await engagementApi.deleteReply(courseId, review.id);
                  } catch (error) {
                    if (hasCode(error, ErrorCode.ReplyNotFound)) void refresh();
                    throw error;
                  }
                  await refresh();
                }}
              />
            </div>
          ) : null}
        </div>
      ) : canReply ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setEditing(true)}
            aria-label={`Reply to ${author}`}
          >
            Reply
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function ReplyForm({
  courseId,
  review,
  onDone,
  onCancel,
}: {
  courseId: string;
  review: InstructorReview;
  onDone: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [body, setBody] = useState(review.reply?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (text: string) => engagementApi.reply(courseId, review.id, text),
    onSuccess: onDone,
    onError: (err) => setError(problemMessage(err)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = ReviewReplyBodySchema.safeParse(body, { error: friendlyZodError });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid reply');
      return;
    }
    setError(null);
    save.mutate(parsed.data);
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-2" aria-label="Reply">
      <Label htmlFor={id}>Your public reply</Label>
      <Textarea
        id={id}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        maxLength={MAX_REPLY}
        rows={4}
        autoFocus
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Plain text, up to {MAX_REPLY.toLocaleString('en')} characters.
      </p>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save reply'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
