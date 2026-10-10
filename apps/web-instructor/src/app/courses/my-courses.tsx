'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { COURSE_STATUSES, type CourseStatus } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { Label } from '@udemy/ui/components/label';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { CourseBadge } from '@/components/course-badge';
import { QueryError } from '@/components/query-error';
import { catalogApi } from '@/lib/catalog-api';
import { catalogKeys } from '@/lib/catalog-queries';
import { formatDateTime } from '@/lib/format';
import { COURSE_STATUS_LABELS } from '@/lib/labels';

/** "My courses" (design §10): keyset pages, newest change first, with a status filter. */
export function MyCourses() {
  const filterId = useId();
  const [status, setStatus] = useState<CourseStatus | ''>('');
  const courses = useInfiniteQuery({
    queryKey: catalogKeys.myCourses(status),
    queryFn: ({ pageParam }) =>
      catalogApi.myCourses({ status: status || undefined, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
  const rows = courses.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="my-courses-title" className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 id="my-courses-title" className="text-3xl font-bold tracking-tight">
            My courses
          </h1>
          <p className="text-muted-foreground">Build, submit and update your courses.</p>
        </div>
        <Button asChild>
          <Link href="/courses/new">Create course</Link>
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Label htmlFor={filterId}>Status</Label>
        <NativeSelect
          id={filterId}
          className="w-48"
          value={status}
          onChange={(event) => setStatus(event.target.value as CourseStatus | '')}
        >
          <option value="">All courses</option>
          {COURSE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {COURSE_STATUS_LABELS[value]}
            </option>
          ))}
        </NativeSelect>
      </div>

      {courses.isPending ? (
        <div aria-busy="true" aria-label="Loading your courses" className="grid gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : courses.isError && rows.length === 0 ? (
        <QueryError error={courses.error} onRetry={() => void courses.refetch()} />
      ) : rows.length === 0 ? (
        <div className="grid justify-items-start gap-3 rounded-lg border border-dashed p-8">
          <p className="font-medium">
            {status ? 'No courses with this status.' : 'You have not created a course yet.'}
          </p>
          {status ? null : (
            <Button asChild variant="outline">
              <Link href="/courses/new">Create your first course</Link>
            </Button>
          )}
        </div>
      ) : (
        <>
          <Table>
            <TableCaption className="sr-only">Your courses, most recently changed first</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last changed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((course) => (
                <TableRow key={course.id}>
                  <TableCell className="max-w-md">
                    <Link
                      href={`/courses/${course.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {course.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <CourseBadge badge={course.badge} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <time dateTime={course.updatedAt}>{formatDateTime(course.updatedAt)}</time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {courses.isFetchNextPageError ? (
            <QueryError error={courses.error} onRetry={() => void courses.fetchNextPage()} />
          ) : null}
          {courses.hasNextPage ? (
            <div>
              <Button
                variant="outline"
                onClick={() => void courses.fetchNextPage()}
                disabled={courses.isFetchingNextPage}
              >
                {courses.isFetchingNextPage ? (
                  <>
                    <Spinner /> Loading…
                  </>
                ) : (
                  'Load more'
                )}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
