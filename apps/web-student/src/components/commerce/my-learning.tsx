'use client';

import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import type { LearningCard, LearningCardPage } from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import Link from 'next/link';

import { EmptyState } from '@/components/catalog/catalog-states';
import { CourseThumbnail } from '@/components/catalog/course-thumbnail';
import { commerceKeys, fetchMyLearning } from '@/lib/commerce/client';
import { learnHref } from '@/lib/commerce/links';
import { problemMessage } from '@/lib/problem';

/**
 * `/my-learning` (design §10): the ACTIVE enrollments, newest first, with keyset "Load more".
 * `progress` is always null in Phase 4; the cards link to the landing page until the Phase 5
 * player exists (`learnHref`).
 */
export function MyLearning() {
  const query = useInfiniteQuery<
    LearningCardPage,
    Error,
    InfiniteData<LearningCardPage, string | null>,
    typeof commerceKeys.myLearning,
    string | null
  >({
    queryKey: commerceKeys.myLearning,
    queryFn: ({ pageParam, signal }) => fetchMyLearning(pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const { error } = query;
  if (query.isPending) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
        <span className="sr-only" role="status">
          Loading your courses…
        </span>
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          <p>{problemMessage(query.error)}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const cards = query.data.pages.flatMap((page) => page.items);
  if (cards.length === 0) {
    return (
      <EmptyState
        title="You are not enrolled in any course yet"
        action={
          <Button asChild>
            <Link href="/courses">Browse courses</Link>
          </Button>
        }
      >
        Courses you buy or enroll in for free show up here.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ul
        aria-label="Your courses"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        {cards.map((card) => (
          <li key={card.enrollmentId}>
            <LearningCourseCard card={card} />
          </li>
        ))}
      </ul>
      {query.isFetchNextPageError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{problemMessage(error)}</AlertDescription>
        </Alert>
      ) : null}
      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            aria-busy={query.isFetchingNextPage || undefined}
          >
            {query.isFetchingNextPage ? <Spinner className="size-4" /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function LearningCourseCard({ card }: { card: LearningCard }) {
  return (
    <article
      data-testid="learning-card"
      className="relative flex h-full flex-col overflow-hidden rounded-lg border bg-card shadow-xs transition-shadow focus-within:ring-[3px] focus-within:ring-ring/50 hover:shadow-md"
    >
      <CourseThumbnail
        courseId={card.courseId}
        title={card.title}
        hasThumbnail={card.hasThumbnail}
      />
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-2 leading-snug font-semibold">
          <Link
            href={learnHref(card.slug)}
            className="outline-none after:absolute after:inset-0 after:content-['']"
          >
            {card.title}
          </Link>
        </h3>
        {card.instructor ? (
          <p className="text-xs text-muted-foreground">{card.instructor.displayName}</p>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
          {card.archived ? (
            <Badge variant="secondary" title="No longer sold; you keep access">
              Archived
            </Badge>
          ) : null}
          {card.source === 'FREE' ? <Badge variant="outline">Free</Badge> : null}
          <span className="ml-auto text-xs text-muted-foreground">
            {card.progress === null ? 'Start learning' : `${card.progress}% complete`}
          </span>
        </div>
      </div>
    </article>
  );
}
