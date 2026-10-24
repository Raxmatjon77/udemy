'use client';

import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import type { CourseRating, PublicReview, PublicReviewPage } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { RatingSummary } from '@udemy/ui/components/rating-summary';
import { StarRating } from '@udemy/ui/components/star-rating';
import { useMemo, useState } from 'react';

import { engagementKeys, fetchPublicReviews } from '@/lib/engagement/client';
import { formatDate } from '@/lib/format';
import { problemMessage } from '@/lib/problem';

import { ReportButton } from '@/components/learning/report-dialog';

/**
 * "Student feedback" on the landing page (design D10, D11, §10): the rating summary with its
 * histogram (a row filters the list by stars) and the public reviews, newest first, keyset
 * "Load more". Review and reply bodies are plain text, rendered as React text (D22).
 */
export function CourseReviews({
  courseId,
  rating,
  signedIn,
}: {
  courseId: string;
  /** Server-rendered summary; undefined when it could not be loaded. */
  rating: CourseRating | undefined;
  signedIn: boolean;
}) {
  const [filter, setFilter] = useState<number | null>(null);
  const query = useInfiniteQuery<
    PublicReviewPage,
    Error,
    InfiniteData<PublicReviewPage, string | null>,
    ReturnType<typeof engagementKeys.publicReviews>,
    string | null
  >({
    queryKey: engagementKeys.publicReviews(courseId, filter),
    queryFn: ({ pageParam, signal }) => fetchPublicReviews(courseId, filter, pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 60_000,
  });
  const reviews = useMemo(() => {
    const seen = new Set<string>();
    const out: PublicReview[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const review of page.items) {
        if (!seen.has(review.id)) {
          seen.add(review.id);
          out.push(review);
        }
      }
    }
    return out;
  }, [query.data]);

  return (
    <div className="flex flex-col gap-6">
      {rating ? (
        <RatingSummary
          average={rating.average}
          count={rating.count}
          histogram={rating.histogram}
          selectedRating={filter}
          onSelectRating={setFilter}
        />
      ) : null}
      {filter !== null ? (
        <p className="flex items-center gap-2 text-sm">
          Showing {filter}-star reviews.
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setFilter(null)}>
            Show all
          </Button>
        </p>
      ) : null}

      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading reviews…
        </p>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemMessage(query.error)}
        </p>
      ) : reviews.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {filter === null ? 'No reviews yet.' : 'No reviews with this rating.'}
        </p>
      ) : (
        <ul aria-label="Reviews" className="flex flex-col divide-y">
          {reviews.map((review) => (
            <li key={review.id} data-testid="review" className="flex flex-col gap-2 py-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">
                  {review.author?.displayName ?? 'Former student'}
                </span>
                <StarRating value={review.rating} starClassName="size-3.5" />
                <time dateTime={review.createdAt} className="text-xs text-muted-foreground">
                  {formatDate(review.createdAt)}
                </time>
                {review.editedAt ? (
                  <span className="text-xs text-muted-foreground">(edited)</span>
                ) : null}
                {signedIn ? (
                  <span className="ml-auto">
                    <ReportButton type="REVIEW" subjectId={review.id} />
                  </span>
                ) : null}
              </div>
              {review.body ? <p className="text-sm whitespace-pre-line">{review.body}</p> : null}
              {review.reply ? (
                <div
                  className="ml-4 rounded-md border-l-4 bg-muted/40 p-3 text-sm"
                  data-testid="review-reply"
                >
                  <p className="mb-1 text-xs font-medium">
                    Response from {review.reply.author?.displayName ?? 'the instructor'}
                  </p>
                  <p className="whitespace-pre-line">{review.reply.body}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          className="self-start"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more reviews
        </Button>
      ) : null}
    </div>
  );
}
