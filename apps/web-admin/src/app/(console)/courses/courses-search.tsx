'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  AdminCoursePageSchema,
  COURSE_STATUSES,
  CourseDetailSchema,
  ErrorCode,
  TakedownCourseRequestSchema,
  type AdminCourseRow,
  type AdminCoursesQuery,
} from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Card, CardContent } from '@udemy/ui/components/card';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';
import { NativeSelect } from '@udemy/ui/components/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { LoadMore } from '@/components/load-more';
import { QueryError } from '@/components/query-error';
import { ReasonDialog } from '@/components/reason-dialog';
import { TableSkeleton } from '@/components/table-skeleton';
import { api, queryString } from '@/lib/api';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import { COURSE_BADGE_LABEL, COURSE_BADGE_VARIANT, COURSE_STATUS_LABEL } from '@/lib/labels';
import { hasCode, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';
import { formResolver } from '@/lib/zod-messages';

export type CourseFilters = Pick<AdminCoursesQuery, 'q' | 'status' | 'ownerId'>;

const PAGE_SIZE = 20;

/** The search form; "" means "any status". `q` follows the API rule (≥ 3 characters). */
const SearchFormSchema = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .refine((value) => value === '' || value.length >= 3, {
      message: 'Enter at least 3 characters, or leave it empty.',
    }),
  status: z.enum(['', ...COURSE_STATUSES]),
});

const TakedownFormSchema = TakedownCourseRequestSchema;

const ACTION_MESSAGES: MessageOverrides = {
  [ErrorCode.InvalidStateTransition]:
    'The course changed in the meantime (it is no longer in the state shown). The list was refreshed; check it and try again.',
  [ErrorCode.CourseNotFound]: 'This course no longer exists. The list was refreshed.',
  [ErrorCode.NotFound]: 'This course no longer exists. The list was refreshed.',
};

function SearchForm({ filters }: { filters: CourseFilters }) {
  const router = useRouter();
  const defaultValues: z.input<typeof SearchFormSchema> = {
    q: filters.q ?? '',
    status: filters.status ?? '',
  };
  const { register, handleSubmit, formState } = useForm({
    resolver: formResolver(SearchFormSchema),
    defaultValues,
  });

  return (
    <form
      role="search"
      noValidate
      onSubmit={handleSubmit((values) =>
        router.push(`/courses${queryString({ ...values, ownerId: filters.ownerId })}`),
      )}
      className="grid items-start gap-4 sm:grid-cols-[1fr_12rem_auto]"
    >
      <FormField id="q" label="Title or slug" error={formState.errors.q?.message}>
        {(field) => <Input {...field} type="search" placeholder="typescript" {...register('q')} />}
      </FormField>
      <FormField id="status" label="Status">
        {(field) => (
          <NativeSelect {...field} {...register('status')}>
            <option value="">Any status</option>
            {COURSE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {COURSE_STATUS_LABEL[status]}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <Button type="submit" className="sm:mt-[1.375rem]">
        Search
      </Button>
    </form>
  );
}

function CourseActions({
  course,
  onDone,
}: {
  course: AdminCourseRow;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const act = useMutation({
    mutationFn: (action: { kind: 'takedown'; reason: string } | { kind: 'restore' }) =>
      api(`/admin/courses/${encodeURIComponent(course.id)}/${action.kind}`, {
        method: 'POST',
        ...(action.kind === 'takedown' ? { json: { reason: action.reason } } : {}),
        schema: CourseDetailSchema,
      }),
    onSuccess: (_detail, action) => {
      onDone(
        action.kind === 'takedown'
          ? `“${course.title}” was taken down. The instructor was notified.`
          : `“${course.title}” is live again.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.courses });
      void queryClient.invalidateQueries({ queryKey: queryKeys.courseReviews });
    },
    onError: (error) => {
      if (
        hasCode(error, ErrorCode.InvalidStateTransition) ||
        hasCode(error, ErrorCode.CourseNotFound) ||
        hasCode(error, ErrorCode.NotFound)
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.courses });
      }
    },
  });

  if (course.status === 'PUBLISHED') {
    return (
      <ReasonDialog
        trigger={
          <Button size="sm" variant="destructive" aria-label={`Take down ${course.title}`}>
            Take down
          </Button>
        }
        title={`Take down “${course.title}”?`}
        description="The course disappears from the catalog right away and a pending update is withdrawn. Students who already have access keep it. You can restore it later."
        label="Reason"
        fieldDescription="10 to 2000 characters. The instructor receives this by email."
        schema={TakedownFormSchema}
        maxLength={2000}
        confirmLabel="Take down course"
        pendingLabel="Taking down…"
        destructive
        onConfirm={(reason) => act.mutateAsync({ kind: 'takedown', reason: reason ?? '' })}
        messages={ACTION_MESSAGES}
      />
    );
  }
  if (course.status === 'ARCHIVED') {
    return (
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="outline" aria-label={`Restore ${course.title}`}>
            Restore
          </Button>
        }
        title={`Restore “${course.title}”?`}
        description="The course goes back to the catalog with its last approved version."
        confirmLabel="Restore course"
        pendingLabel="Restoring…"
        onConfirm={() => act.mutateAsync({ kind: 'restore' })}
        messages={ACTION_MESSAGES}
      />
    );
  }
  return null;
}

function Results({
  filters,
  studentOrigin,
}: {
  filters: CourseFilters;
  studentOrigin: string | null;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const courses = useInfiniteQuery({
    queryKey: queryKeys.courseSearch(filters),
    queryFn: ({ pageParam }) =>
      api(`/admin/courses${queryString({ ...filters, cursor: pageParam, limit: PAGE_SIZE })}`, {
        schema: AdminCoursePageSchema,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const status = (
    <div role="status" aria-live="polite">
      {notice ? (
        <Alert variant="success">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );

  if (courses.isPending) return <TableSkeleton label="Loading courses" />;
  if (!courses.data) {
    return <QueryError error={courses.error} onRetry={() => void courses.refetch()} />;
  }

  const items = courses.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <div className="grid gap-4">
        {status}
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No courses match these filters.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {status}
      <Card className="py-2">
        <CardContent className="px-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead>Instructor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((course) => (
                <TableRow key={course.id} data-testid={`course-${course.id}`}>
                  <TableCell className="max-w-80">
                    <div className="grid gap-0.5">
                      <span className="truncate font-medium" title={course.title}>
                        {course.title}
                      </span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{course.slug}</span>
                        {course.status === 'PUBLISHED' && studentOrigin ? (
                          <a
                            href={`${studentOrigin}/course/${encodeURIComponent(course.slug)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary underline underline-offset-4"
                          >
                            Public page<span className="sr-only"> (opens in a new tab)</span>
                          </a>
                        ) : null}
                        {course.pendingRevisionId ? (
                          <Link
                            href={`/course-reviews/${course.pendingRevisionId}`}
                            className="text-primary underline underline-offset-4"
                          >
                            Review submission
                          </Link>
                        ) : null}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      <Link
                        href={`/users/${course.owner.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {course.owner.displayName}
                      </Link>
                      {course.owner.banned ? (
                        <Badge variant="destructive" title="The instructor's account is banned">
                          Owner banned
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      <Badge variant={COURSE_BADGE_VARIANT[course.badge]}>
                        {COURSE_BADGE_LABEL[course.badge]}
                      </Badge>
                      {course.firstPublishedAt ? (
                        <span className="text-xs text-muted-foreground">
                          First published {formatDate(course.firstPublishedAt)}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <time dateTime={course.updatedAt} title={formatDateTime(course.updatedAt)}>
                      {formatRelative(course.updatedAt)}
                    </time>
                  </TableCell>
                  <TableCell className="text-right">
                    <CourseActions course={course} onDone={setNotice} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <LoadMore query={courses} count={items.length} noun={['course', 'courses']} />
    </div>
  );
}

export function CoursesSearch({
  filters,
  studentOrigin,
}: {
  filters: CourseFilters;
  studentOrigin: string | null;
}) {
  return (
    <div className="grid gap-6">
      <SearchForm filters={filters} />
      {filters.ownerId ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          Showing one instructor’s courses only.
          <Link
            href={`/courses${queryString({ q: filters.q, status: filters.status })}`}
            className="text-primary underline underline-offset-4"
          >
            Show all instructors
          </Link>
        </p>
      ) : null}
      <Results filters={filters} studentOrigin={studentOrigin} />
    </div>
  );
}
