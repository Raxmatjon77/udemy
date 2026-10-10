'use client';

import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import type { CourseCard as CourseCardData, CourseCardPage } from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';
import { useMemo } from 'react';

import type { BrowseFilters } from '@/lib/catalog/browse-params';
import { catalogQueryKeys, fetchCoursePage } from '@/lib/catalog/client';
import { pluralize } from '@/lib/catalog/format';
import { problemMessage } from '@/lib/problem';

import { CourseGrid } from './course-card';

/**
 * The course grid with keyset "Load more". The first page is rendered by the server page (it
 * comes in as `initialPage`); later pages are fetched through the BFF with the API's
 * `nextCursor`, passed back verbatim. The parent keys this component by the filters, so a
 * filter change starts a fresh list.
 */
export function BrowseResults({
  filters,
  initialPage,
  limit,
}: {
  /** The API filters (a category page adds its category here). */
  filters: BrowseFilters;
  initialPage: CourseCardPage;
  limit: number;
}) {
  const query = useInfiniteQuery<
    CourseCardPage,
    Error,
    InfiniteData<CourseCardPage, string | null>,
    ReturnType<typeof catalogQueryKeys.courses>,
    string | null
  >({
    queryKey: catalogQueryKeys.courses(filters, limit),
    queryFn: ({ pageParam, signal }) => fetchCoursePage(filters, pageParam, limit, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
    initialData: { pages: [initialPage], pageParams: [null] },
    // The server just rendered page one; do not refetch it on mount.
    staleTime: 60_000,
  });

  const courses = useMemo(() => {
    const seen = new Set<string>();
    const out: CourseCardData[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const course of page.items) {
        if (!seen.has(course.id)) {
          seen.add(course.id);
          out.push(course);
        }
      }
    }
    return out;
  }, [query.data]);

  return (
    <div className="flex flex-col gap-6">
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {courses.length === 0
          ? 'No courses found'
          : `Showing ${pluralize(courses.length, 'course')}`}
      </p>

      {courses.length > 0 ? (
        <CourseGrid courses={courses} priorityCount={4} label="Courses" />
      ) : null}

      {query.isFetchNextPageError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            <p>{problemMessage(query.error)}</p>
          </AlertDescription>
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
            {query.isFetchingNextPage ? (
              <>
                <Spinner className="size-4" />
                Loading…
              </>
            ) : query.isFetchNextPageError ? (
              'Try again'
            ) : (
              'Load more courses'
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
