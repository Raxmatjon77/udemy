'use client';

import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  InstructorApplicationPageSchema,
  type InstructorApplicationStatus,
} from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Card, CardContent } from '@udemy/ui/components/card';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { QueryError } from '@/components/query-error';
import { api, queryString } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { APPLICATION_STATUS_LABEL, EXPERIENCE_LABEL } from '@/lib/labels';
import { queryKeys } from '@/lib/queries';

const PAGE_SIZE = 20;

export function ApplicationsQueue({ status }: { status: InstructorApplicationStatus }) {
  const queue = useInfiniteQuery({
    queryKey: queryKeys.applicationQueue(status),
    queryFn: ({ pageParam }) =>
      api(
        `/admin/instructor-applications${queryString({ status, cursor: pageParam, limit: PAGE_SIZE })}`,
        { schema: InstructorApplicationPageSchema },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  if (queue.isPending) {
    return (
      <Card aria-busy="true" aria-label="Loading applications">
        <CardContent className="grid gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }
  // Only a failed FIRST page replaces the table; a failed "load more" is shown below it.
  if (!queue.data) {
    return <QueryError error={queue.error} onRetry={() => void queue.refetch()} />;
  }

  const items = queue.data.pages.flatMap((page) => page.items);

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No {APPLICATION_STATUS_LABEL[status].toLowerCase()} applications.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      <Card className="py-2">
        <CardContent className="px-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Applicant</TableHead>
                <TableHead>Expertise</TableHead>
                <TableHead>Experience</TableHead>
                <TableHead>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((application) => (
                <TableRow key={application.id}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <Link
                        href={`/instructor-applications/${application.id}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {application.applicant.displayName}
                      </Link>
                      <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        {application.applicant.email}
                        {!application.applicant.emailVerified ? (
                          <Badge variant="outline">Unverified</Badge>
                        ) : null}
                        {application.applicant.status === 'BANNED' ? (
                          <Badge variant="destructive">Banned</Badge>
                        ) : null}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64 truncate" title={application.expertise}>
                    {application.expertise}
                  </TableCell>
                  <TableCell>{EXPERIENCE_LABEL[application.experienceLevel]}</TableCell>
                  <TableCell>
                    <time
                      dateTime={application.submittedAt}
                      title={formatDateTime(application.submittedAt)}
                    >
                      {formatRelative(application.submittedAt)}
                    </time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex items-center justify-between gap-4">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Showing {items.length} application{items.length === 1 ? '' : 's'}
          {queue.hasNextPage ? '' : ' (all)'}
        </p>
        {queue.hasNextPage ? (
          <Button
            variant="outline"
            onClick={() => void queue.fetchNextPage()}
            disabled={queue.isFetchingNextPage}
          >
            {queue.isFetchingNextPage ? <Spinner /> : null}
            {queue.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </div>
      {queue.isFetchNextPageError ? (
        <QueryError error={queue.error} onRetry={() => void queue.fetchNextPage()} />
      ) : null}
    </div>
  );
}
