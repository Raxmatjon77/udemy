'use client';

import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ReviewQueuePageSchema } from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Card, CardContent } from '@udemy/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { LoadMore } from '@/components/load-more';
import { QueryError } from '@/components/query-error';
import { TableSkeleton } from '@/components/table-skeleton';
import { api, queryString } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { REVISION_KIND_LABEL } from '@/lib/labels';
import { queryKeys } from '@/lib/queries';

const PAGE_SIZE = 20;

/** `GET /admin/course-reviews`: pending revisions, oldest first, keyset "load more". */
export function ReviewQueue() {
  const queue = useInfiniteQuery({
    queryKey: queryKeys.courseReviewQueue,
    queryFn: ({ pageParam }) =>
      api(`/admin/course-reviews${queryString({ cursor: pageParam, limit: PAGE_SIZE })}`, {
        schema: ReviewQueuePageSchema,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  if (queue.isPending) return <TableSkeleton label="Loading the review queue" />;
  // Only a failed FIRST page replaces the table; a failed "load more" is shown below it.
  if (!queue.data) {
    return <QueryError error={queue.error} onRetry={() => void queue.refetch()} />;
  }

  const items = queue.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Nothing to review. New submissions appear here.
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
                <TableHead>Course</TableHead>
                <TableHead>Instructor</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.revisionId}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <Link
                        href={`/course-reviews/${item.revisionId}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {item.title}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        Revision {item.revisionNo}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/users/${item.owner.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {item.owner.displayName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={item.kind === 'INITIAL' ? 'default' : 'secondary'}>
                      {REVISION_KIND_LABEL[item.kind]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <time dateTime={item.submittedAt} title={formatDateTime(item.submittedAt)}>
                      {formatRelative(item.submittedAt)}
                    </time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <LoadMore query={queue} count={items.length} noun={['submission', 'submissions']} />
    </div>
  );
}
