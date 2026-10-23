'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ApproveRefundRequestSchema,
  AdminRefundQueuePageSchema,
  ADMIN_REFUND_FILTER_STATUSES,
  ErrorCode,
  REFUND_REASON_LABELS,
  RefundDecisionResponseSchema,
  RejectRefundRequestSchema,
  type AdminRefundQueueItem,
  type RefundStatus,
} from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Card, CardContent } from '@udemy/ui/components/card';
import { cn } from '@udemy/ui/lib/utils';
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
import { ReasonDialog } from '@/components/reason-dialog';
import { TableSkeleton } from '@/components/table-skeleton';
import { api, queryString } from '@/lib/api';
import {
  money,
  REFUND_INITIATOR_LABEL,
  REFUND_REVIEW_THRESHOLD,
  REFUND_STATUS_LABEL,
} from '@/lib/commerce';
import { formatDateTime } from '@/lib/format';
import { hasCode, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

const PAGE_SIZE = 20;

/** What the list shows when a status has no refunds. */
const EMPTY_LABEL: Record<RefundStatus, string> = {
  REQUESTED: 'No refunds waiting for review.',
  APPROVED: 'No approved refunds waiting to be sent.',
  SUBMITTED: 'No refunds waiting for the payment provider.',
  SUCCEEDED: 'No completed refunds.',
  FAILED: 'No failed refunds.',
  REJECTED: 'No rejected refunds.',
};

/** The date column: when the refund reached the listed status (as far as the row says). */
function statusDate(item: AdminRefundQueueItem): string {
  if (item.status === 'SUCCEEDED' && item.succeededAt) return item.succeededAt;
  if ((item.status === 'APPROVED' || item.status === 'SUBMITTED') && item.approvedAt) {
    return item.approvedAt;
  }
  return item.createdAt;
}

const DATE_HEADING: Record<RefundStatus, string> = {
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  SUBMITTED: 'Approved',
  SUCCEEDED: 'Refunded',
  FAILED: 'Failure',
  REJECTED: 'Requested',
};

/** The optional note on approve and retry: an empty textarea sends no reason. */
const NoteFormSchema = z.object({
  reason: z
    .string()
    .transform((value) => (value.trim() === '' ? undefined : value))
    .pipe(ApproveRefundRequestSchema.shape.reason),
});

const DECISION_MESSAGES: MessageOverrides = {
  [ErrorCode.InvalidStateTransition]:
    'Another admin already handled this refund. The queue was refreshed.',
  [ErrorCode.RefundNotFound]: 'This refund no longer exists. The queue was refreshed.',
  [ErrorCode.RefundAlreadyRequested]:
    'The line already has another refund in progress. The queue was refreshed.',
};

type Decision = 'approve' | 'reject' | 'retry';

function QueueTabs({ status }: { status: RefundStatus }) {
  return (
    <nav aria-label="Refund statuses">
      <ul className="flex flex-wrap gap-1 border-b">
        {ADMIN_REFUND_FILTER_STATUSES.map((item) => (
          <li key={item}>
            <Link
              href={`/refunds${queryString({ status: item === 'REQUESTED' ? null : item })}`}
              aria-current={item === status ? 'page' : undefined}
              className={cn(
                '-mb-px block border-b-2 px-3 py-2 text-sm font-medium',
                item === status
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {REFUND_STATUS_LABEL[item]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function History({ item }: { item: AdminRefundQueueItem }) {
  const flagged = item.recentRefundCount >= REFUND_REVIEW_THRESHOLD;
  return (
    <div className="grid gap-0.5">
      <span className={cn('tabular-nums', flagged && 'font-semibold text-destructive')}>
        {item.recentRefundCount} in 90 days
      </span>
      {flagged && item.status === 'REQUESTED' ? (
        <span className="text-xs text-muted-foreground">
          {REFUND_REVIEW_THRESHOLD} or more refunds send a request to review
        </span>
      ) : null}
    </div>
  );
}

function Actions({
  item,
  status,
  onDone,
}: {
  item: AdminRefundQueueItem;
  status: RefundStatus;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: ({ decision, reason }: { decision: Decision; reason: string | undefined }) =>
      api(`/admin/refunds/${encodeURIComponent(item.id)}/${decision}`, {
        method: 'POST',
        json: reason === undefined ? {} : { reason },
        schema: RefundDecisionResponseSchema,
      }),
    onSuccess: (_refund, { decision }) => {
      const verb = { approve: 'Approved', reject: 'Rejected', retry: 'Retrying' }[decision];
      onDone(`${verb} the refund of ${item.courseTitle} for order #${item.orderNumber}.`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.refunds });
      void queryClient.invalidateQueries({ queryKey: queryKeys.order(item.orderId) });
    },
    onError: (error) => {
      if (
        hasCode(error, ErrorCode.InvalidStateTransition) ||
        hasCode(error, ErrorCode.RefundNotFound) ||
        hasCode(error, ErrorCode.RefundAlreadyRequested)
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.refundQueue(status) });
      }
    },
  });
  const who = item.buyer?.displayName ?? 'the buyer';
  const amount = money(item.amount, item.currency);
  const name = `${item.courseTitle}, order #${item.orderNumber}`;

  if (item.status !== 'REQUESTED' && item.status !== 'FAILED') {
    return <span className="text-xs text-muted-foreground">No action needed</span>;
  }

  if (item.status === 'FAILED') {
    return (
      <div className="flex flex-wrap gap-2">
        <ReasonDialog
          trigger={
            <Button size="sm" aria-label={`Retry refund: ${name}`}>
              Retry
            </Button>
          }
          title={`Retry the refund of ${amount}?`}
          description={`The refund is sent to the payment provider again (attempt ${item.attempt + 1}). ${who} already lost access to the course when it was approved.`}
          label="Note"
          optional
          fieldDescription="Stored with the refund."
          schema={NoteFormSchema}
          confirmLabel="Retry refund"
          pendingLabel="Retrying…"
          maxLength={2000}
          messages={DECISION_MESSAGES}
          onConfirm={(reason) => decide.mutateAsync({ decision: 'retry', reason })}
        />
        {item.buyer ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/users/${item.buyer.id}`} aria-label={`Re-grant access: ${name}`}>
              Re-grant access
            </Link>
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <ReasonDialog
        trigger={
          <Button size="sm" aria-label={`Approve refund: ${name}`}>
            Approve
          </Button>
        }
        title={`Approve the refund of ${amount}?`}
        description={`${who} loses access to ${item.courseTitle} immediately and the money is returned through the payment provider.`}
        label="Note"
        optional
        fieldDescription="Stored with the refund."
        schema={NoteFormSchema}
        confirmLabel="Approve refund"
        pendingLabel="Approving…"
        maxLength={2000}
        messages={DECISION_MESSAGES}
        onConfirm={(reason) => decide.mutateAsync({ decision: 'approve', reason })}
      />
      <ReasonDialog
        trigger={
          <Button size="sm" variant="outline" aria-label={`Reject refund: ${name}`}>
            Reject
          </Button>
        }
        title={`Reject the refund of ${amount}?`}
        description={`${who} keeps access to the course and is emailed your reason.`}
        label="Reason"
        fieldDescription="10 to 2000 characters. Emailed to the student."
        schema={RejectRefundRequestSchema}
        confirmLabel="Reject refund"
        pendingLabel="Rejecting…"
        destructive
        maxLength={2000}
        messages={DECISION_MESSAGES}
        onConfirm={(reason) => decide.mutateAsync({ decision: 'reject', reason })}
      />
    </div>
  );
}

function Queue({ status }: { status: RefundStatus }) {
  const [notice, setNotice] = useState('');
  const refunds = useInfiniteQuery({
    queryKey: queryKeys.refundQueue(status),
    queryFn: ({ pageParam }) =>
      api(`/admin/refunds${queryString({ status, cursor: pageParam, limit: PAGE_SIZE })}`, {
        schema: AdminRefundQueuePageSchema,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const live = (
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground empty:hidden">
      {notice}
    </p>
  );

  if (refunds.isPending) return <TableSkeleton label="Loading refunds" />;
  if (!refunds.data) {
    return <QueryError error={refunds.error} onRetry={() => void refunds.refetch()} />;
  }
  const items = refunds.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <div className="grid gap-4">
        {live}
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {EMPTY_LABEL[status]}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {live}
      <Card className="py-2">
        <CardContent className="px-2">
          <Table aria-label="Refunds">
            <TableHeader>
              <TableRow>
                <TableHead>Refund</TableHead>
                <TableHead>Buyer</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Refund history</TableHead>
                <TableHead>{DATE_HEADING[status]}</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id} data-testid="refund-row" className="align-top">
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{item.courseTitle}</span>
                      <Link
                        href={`/orders/${item.orderId}`}
                        className="text-xs text-primary underline-offset-4 hover:underline"
                      >
                        Order #{item.orderNumber}
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell>
                    {item.buyer ? (
                      <div className="grid gap-0.5">
                        <Link
                          href={`/users/${item.buyer.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {item.buyer.displayName}
                        </Link>
                        <span className="text-xs text-muted-foreground">{item.buyer.email}</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Deleted account</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(item.amount, item.currency)}
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <div>{REFUND_REASON_LABELS[item.reasonCode]}</div>
                    {item.comment ? (
                      <div className="text-xs whitespace-pre-line text-muted-foreground">
                        {item.comment}
                      </div>
                    ) : null}
                    <div className="text-xs text-muted-foreground">
                      By {REFUND_INITIATOR_LABEL[item.initiatedBy].toLowerCase()}
                    </div>
                  </TableCell>
                  <TableCell>
                    <History item={item} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {status === 'FAILED' ? (
                      <div className="grid gap-0.5">
                        <Badge variant="destructive">{item.failureCode ?? 'Failed'}</Badge>
                        <span className="text-xs text-muted-foreground">
                          Attempt {item.attempt}
                        </span>
                      </div>
                    ) : (
                      <time dateTime={statusDate(item)}>{formatDateTime(statusDate(item))}</time>
                    )}
                  </TableCell>
                  <TableCell>
                    <Actions item={item} status={status} onDone={setNotice} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <LoadMore query={refunds} count={items.length} noun={['refund', 'refunds']} />
    </div>
  );
}

export function RefundsQueue({ status }: { status: RefundStatus }) {
  return (
    <div className="grid gap-6">
      <QueueTabs status={status} />
      <Queue status={status} />
    </div>
  );
}
