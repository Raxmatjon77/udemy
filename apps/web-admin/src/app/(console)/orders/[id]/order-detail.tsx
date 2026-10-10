'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  AcceptPaymentRequestSchema,
  AcceptPaymentResponseSchema,
  AdminMoneyReasonSchema,
  AdminOrderDetailSchema,
  AdminRefundOrderLinesResponseSchema,
  ErrorCode,
  REFUND_REASON_LABELS,
  sumMoney,
  type AdminOrderDetail,
  type AdminOrderLine,
  type AdminRefund,
} from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@udemy/ui/components/card';
import { Skeleton } from '@udemy/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { CopyValue } from '@/components/copy-value';
import { QueryError } from '@/components/query-error';
import { ReasonDialog } from '@/components/reason-dialog';
import { api } from '@/lib/api';
import {
  formatBps,
  isLiveRefund,
  money,
  ORDER_STATUS_BADGE,
  ORDER_STATUS_LABEL,
  ORDER_TRANSITION_CAUSE_LABEL,
  PAYMENT_STATUS_LABEL,
  PROVIDER_EVENT_OUTCOME_LABEL,
  REFUND_INITIATOR_LABEL,
  REFUND_STATUS_BADGE,
  REFUND_STATUS_LABEL,
  stripePaymentUrl,
} from '@/lib/commerce';
import { formatDateTime } from '@/lib/format';
import { hasCode, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

const RefundFormSchema = z.object({ reason: AdminMoneyReasonSchema });

const ACTION_MESSAGES: MessageOverrides = {
  [ErrorCode.InvalidStateTransition]:
    'The order changed in the meantime and no longer allows this. The page was refreshed.',
};

/** Codes after which the page is out of date: refetch the order. */
const STALE_CODES = [
  ErrorCode.InvalidStateTransition,
  ErrorCode.RefundAlreadyRequested,
  ErrorCode.RefundNotApplicable,
];

/** The newest refund of each line (the live one wins; a line has at most one live refund). */
function refundByLine(refunds: readonly AdminRefund[]): Map<string, AdminRefund> {
  const out = new Map<string, AdminRefund>();
  for (const refund of refunds) {
    const current = out.get(refund.orderLineId);
    if (!current || !isLiveRefund(current.status) || isLiveRefund(refund.status)) {
      out.set(refund.orderLineId, refund);
    }
  }
  return out;
}

/** Why a line cannot be refunded by an admin now, or null (admins ignore the window, §5). */
function lineRefundBlock(order: AdminOrderDetail, line: AdminOrderLine, refund?: AdminRefund) {
  if (order.paidAt === null || order.status === 'REFUNDED') return 'Order not paid';
  if (line.finalAmount === '0.00') return 'Free line';
  if (refund && isLiveRefund(refund.status)) return 'Refund in progress';
  return null;
}

function Amount({ value, currency }: { value: string; currency: AdminOrderDetail['currency'] }) {
  return <span className="tabular-nums">{money(value, currency)}</span>;
}

function Summary({ order }: { order: AdminOrderDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2>Summary</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="font-medium">Buyer</dt>
          <dd>
            {order.buyer ? (
              <>
                <Link
                  href={`/users/${order.buyer.id}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {order.buyer.displayName}
                </Link>{' '}
                <span className="text-muted-foreground">{order.buyer.email}</span>
                {order.buyer.status === 'BANNED' ? (
                  <Badge variant="destructive" className="ml-2">
                    Banned
                  </Badge>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">Deleted account</span>
            )}
          </dd>
          <dt className="font-medium">Placed</dt>
          <dd>
            <time dateTime={order.placedAt}>{formatDateTime(order.placedAt)}</time>
          </dd>
          <dt className="font-medium">Paid</dt>
          <dd>
            {order.paidAt ? (
              <time dateTime={order.paidAt}>{formatDateTime(order.paidAt)}</time>
            ) : (
              '—'
            )}
          </dd>
          {order.closedAt ? (
            <>
              <dt className="font-medium">Closed</dt>
              <dd>
                <time dateTime={order.closedAt}>{formatDateTime(order.closedAt)}</time>
              </dd>
            </>
          ) : null}
          <dt className="font-medium">Subtotal</dt>
          <dd>
            <Amount value={order.subtotalAmount} currency={order.currency} />
          </dd>
          <dt className="font-medium">Discounts</dt>
          <dd>
            <Amount value={order.discountAmount} currency={order.currency} />
          </dd>
          <dt className="font-medium">Total</dt>
          <dd className="font-semibold">
            <Amount value={order.totalAmount} currency={order.currency} />
          </dd>
          <dt className="font-medium">Refunded</dt>
          <dd>
            <Amount value={order.refundedAmount} currency={order.currency} />
          </dd>
          <dt className="font-medium">Order id</dt>
          <dd>
            <CopyValue value={order.id} label="order id" />
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}

function Lines({ order }: { order: AdminOrderDetail }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState('');
  const refunds = refundByLine(order.refunds);
  const refundable = order.lines.filter(
    (line) => lineRefundBlock(order, line, refunds.get(line.id)) === null,
  );
  const chosen = refundable.filter((line) => selected.has(line.id));
  const chosenTotal = sumMoney(chosen.map((line) => line.finalAmount));

  const refund = useMutation({
    mutationFn: (reason: string) =>
      api(`/admin/orders/${encodeURIComponent(order.id)}/refunds`, {
        method: 'POST',
        json: { orderLineIds: chosen.map((line) => line.id), reason },
        schema: AdminRefundOrderLinesResponseSchema,
      }),
    onSuccess: (created) => {
      setSelected(new Set());
      setNotice(
        `${created.length} refund${created.length === 1 ? '' : 's'} approved; access to the course was revoked.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
      void queryClient.invalidateQueries({ queryKey: queryKeys.refunds });
    },
    onError: (error) => {
      if (STALE_CODES.some((code) => hasCode(error, code))) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.order(order.id) });
      }
    },
  });

  function toggle(lineId: string, on: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(lineId);
      else next.delete(lineId);
      return next;
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2>Lines</h2>
        </CardTitle>
        <CardDescription>
          The snapshot at purchase. Shares: the instructor gets the stated rate of the final amount;
          the platform keeps the rest.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-2">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <span className="sr-only">Select</span>
              </TableHead>
              <TableHead>Course</TableHead>
              <TableHead className="text-right">List</TableHead>
              <TableHead className="text-right">Discount</TableHead>
              <TableHead>Coupon</TableHead>
              <TableHead className="text-right">Final</TableHead>
              <TableHead className="text-right">Instructor share</TableHead>
              <TableHead className="text-right">Platform share</TableHead>
              <TableHead>Refund</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.lines.map((line) => {
              const lineRefund = refunds.get(line.id);
              const block = lineRefundBlock(order, line, lineRefund);
              return (
                <TableRow key={line.id} data-testid={`line-${line.lineNo}`} className="align-top">
                  <TableCell>
                    <input
                      type="checkbox"
                      className="size-4"
                      aria-label={`Select line ${line.lineNo}: ${line.courseTitle}`}
                      disabled={block !== null || refund.isPending}
                      checked={block === null && selected.has(line.id)}
                      onChange={(event) => toggle(line.id, event.target.checked)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span className="font-medium">{line.courseTitle}</span>
                      <span className="text-xs text-muted-foreground">
                        {line.instructor?.displayName ?? 'Unknown instructor'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={line.listAmount} currency={order.currency} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={line.discountAmount} currency={order.currency} />
                  </TableCell>
                  <TableCell>
                    {line.couponCode ? (
                      <code className="font-mono text-xs">{line.couponCode}</code>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    <Amount value={line.finalAmount} currency={order.currency} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={line.instructorShareAmount} currency={order.currency} />
                    <div className="text-xs text-muted-foreground">
                      {formatBps(line.revenueShareBps)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={line.platformShareAmount} currency={order.currency} />
                  </TableCell>
                  <TableCell>
                    {lineRefund ? (
                      <Badge variant={REFUND_STATUS_BADGE[lineRefund.status]}>
                        {REFUND_STATUS_LABEL[lineRefund.status]}
                      </Badge>
                    ) : block ? (
                      <span className="text-xs text-muted-foreground">{block}</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-4 border-t pt-6">
        <ReasonDialog
          trigger={
            <Button variant="destructive" disabled={chosen.length === 0}>
              Refund selected lines
            </Button>
          }
          title={`Refund ${chosen.length} line${chosen.length === 1 ? '' : 's'} of order #${order.orderNumber}?`}
          description={
            <>
              {money(chosenTotal, order.currency)} goes back to the buyer (
              {chosen.map((line) => line.courseTitle).join(', ')}). The refunds are approved at once
              and the buyer loses access to these courses immediately.
            </>
          }
          label="Reason"
          fieldDescription="10 to 2000 characters. Stored on the refund and in the audit trail."
          schema={RefundFormSchema}
          confirmLabel="Refund"
          pendingLabel="Refunding…"
          destructive
          maxLength={2000}
          messages={ACTION_MESSAGES}
          onConfirm={(reason) => refund.mutateAsync(reason ?? '')}
        />
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {notice || (chosen.length > 0 ? `${chosen.length} selected` : '')}
        </p>
      </CardFooter>
    </Card>
  );
}

function AcceptPayment({ order }: { order: AdminOrderDetail }) {
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: (reason: string) =>
      api(`/admin/orders/${encodeURIComponent(order.id)}/accept-payment`, {
        method: 'POST',
        json: { reason },
        schema: AcceptPaymentResponseSchema,
      }),
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.order(order.id), detail);
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders });
    },
    onError: (error) => {
      if (hasCode(error, ErrorCode.InvalidStateTransition)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.order(order.id) });
      }
    },
  });
  const mismatch = order.providerEvents.some((event) => event.outcome === 'MISMATCH');

  return (
    <Alert variant="destructive">
      <AlertDescription className="grid gap-3">
        <p>
          This order is in payment review
          {mismatch
            ? ': the amount or currency the provider reported did not match the order.'
            : '.'}{' '}
          The buyer has no access yet. Accept the payment to mark it paid and enroll the buyer, or
          refund the lines to return the money.
        </p>
        <div>
          <ReasonDialog
            trigger={<Button variant="outline">Accept payment</Button>}
            title={`Accept the payment for order #${order.orderNumber}?`}
            description="The order becomes paid and the buyer is enrolled in every course of the order."
            label="Reason"
            fieldDescription="10 to 2000 characters. Stored on the order timeline."
            schema={AcceptPaymentRequestSchema}
            confirmLabel="Accept payment"
            pendingLabel="Accepting…"
            maxLength={2000}
            messages={ACTION_MESSAGES}
            onConfirm={(reason) => accept.mutateAsync(reason ?? '')}
          />
        </div>
      </AlertDescription>
    </Alert>
  );
}

function Payment({ order }: { order: AdminOrderDetail }) {
  const { payment } = order;
  const livemode = order.providerEvents.some((event) => event.livemode);
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2>Payment</h2>
        </CardTitle>
        <CardDescription>
          {order.settlement === 'NONE'
            ? 'A zero-total order: nothing was charged and no provider was involved.'
            : 'The Checkout Session of this order.'}
        </CardDescription>
      </CardHeader>
      {payment ? (
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-[12rem_1fr]">
            <dt className="font-medium">Provider</dt>
            <dd>{payment.provider === 'STRIPE' ? 'Stripe' : payment.provider}</dd>
            <dt className="font-medium">Status</dt>
            <dd>
              <Badge variant="outline">{PAYMENT_STATUS_LABEL[payment.status]}</Badge>
            </dd>
            <dt className="font-medium">Amount</dt>
            <dd>
              <Amount value={payment.amount} currency={payment.currency} />
            </dd>
            <dt className="font-medium">Checkout Session</dt>
            <dd>
              {payment.checkoutSessionId ? (
                <CopyValue value={payment.checkoutSessionId} label="Checkout Session id" />
              ) : (
                '—'
              )}
            </dd>
            <dt className="font-medium">Payment intent</dt>
            <dd className="grid gap-1">
              {payment.paymentIntentId ? (
                <>
                  <CopyValue value={payment.paymentIntentId} label="payment intent id" />
                  {payment.provider === 'STRIPE' ? (
                    <a
                      href={stripePaymentUrl(payment.paymentIntentId, livemode)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="w-fit text-xs text-primary underline-offset-4 hover:underline"
                    >
                      Open in the Stripe dashboard
                    </a>
                  ) : null}
                </>
              ) : (
                '—'
              )}
            </dd>
            {payment.sessionExpiresAt ? (
              <>
                <dt className="font-medium">Session expires</dt>
                <dd>
                  <time dateTime={payment.sessionExpiresAt}>
                    {formatDateTime(payment.sessionExpiresAt)}
                  </time>
                </dd>
              </>
            ) : null}
            {payment.succeededAt ? (
              <>
                <dt className="font-medium">Succeeded</dt>
                <dd>
                  <time dateTime={payment.succeededAt}>{formatDateTime(payment.succeededAt)}</time>
                </dd>
              </>
            ) : null}
          </dl>
        </CardContent>
      ) : null}
    </Card>
  );
}

type TimelineEntry = { key: string; at: string; title: string; detail: string[] };

/** Transitions and provider events in one chronological list (both arrive oldest first). */
function timelineOf(order: AdminOrderDetail): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...order.transitions.map((t) => ({
      key: `t-${t.id}`,
      at: t.occurredAt,
      title: t.fromStatus
        ? `${ORDER_STATUS_LABEL[t.fromStatus]} → ${ORDER_STATUS_LABEL[t.toStatus]}`
        : ORDER_STATUS_LABEL[t.toStatus],
      detail: [
        ORDER_TRANSITION_CAUSE_LABEL[t.cause],
        ...(t.providerEventId ? [`Event ${t.providerEventId}`] : []),
        ...(t.reason ? [`Reason: ${t.reason}`] : []),
      ],
    })),
    ...order.providerEvents.map((e) => ({
      key: `e-${e.provider}-${e.eventId}`,
      at: e.receivedAt,
      title: `Webhook ${e.type}`,
      detail: [
        e.outcome ? PROVIDER_EVENT_OUTCOME_LABEL[e.outcome] : 'Not processed yet',
        `${e.eventId} · ${e.objectId}`,
        ...(e.livemode ? ['Live mode'] : []),
      ],
    })),
  ];
  // A stable sort keeps a transition before the event recorded at the same instant.
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function Timeline({ order }: { order: AdminOrderDetail }) {
  const entries = timelineOf(order);
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2>Timeline</h2>
        </CardTitle>
        <CardDescription>Status changes and provider events, oldest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ol aria-label="Order timeline" className="grid gap-4 border-l pl-4">
            {entries.map((entry) => (
              <li key={entry.key} className="grid gap-0.5 text-sm">
                <span className="font-medium">{entry.title}</span>
                <time dateTime={entry.at} className="text-xs text-muted-foreground">
                  {formatDateTime(entry.at)}
                </time>
                {entry.detail.map((line) => (
                  <span key={line} className="text-xs whitespace-pre-line text-muted-foreground">
                    {line}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function Refunds({ order }: { order: AdminOrderDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2>Refunds</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2">
        {order.refunds.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">No refunds for this order.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Requested</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.refunds.map((refund) => (
                <TableRow key={refund.id} className="align-top">
                  <TableCell>
                    <div className="grid gap-0.5">
                      <span>{refund.courseTitle}</span>
                      <span className="text-xs text-muted-foreground">
                        By {REFUND_INITIATOR_LABEL[refund.initiatedBy].toLowerCase()}
                        {refund.attempt > 1 ? ` · attempt ${refund.attempt}` : ''}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={refund.amount} currency={refund.currency} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={REFUND_STATUS_BADGE[refund.status]}>
                      {REFUND_STATUS_LABEL[refund.status]}
                    </Badge>
                    {refund.failureCode ? (
                      <div className="mt-1 font-mono text-xs text-destructive">
                        {refund.failureCode}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <div>{REFUND_REASON_LABELS[refund.reasonCode]}</div>
                    {refund.comment ? (
                      <div className="text-xs whitespace-pre-line text-muted-foreground">
                        {refund.comment}
                      </div>
                    ) : null}
                    {refund.rejectionReason ? (
                      <div className="text-xs whitespace-pre-line text-muted-foreground">
                        Rejected: {refund.rejectionReason}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {refund.providerRefundId ? (
                      <CopyValue value={refund.providerRefundId} label="provider refund id" />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <time dateTime={refund.createdAt}>{formatDateTime(refund.createdAt)}</time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function OrderDetailView({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: queryKeys.order(id),
    queryFn: () =>
      api(`/admin/orders/${encodeURIComponent(id)}`, { schema: AdminOrderDetailSchema }),
  });

  if (detail.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading order" className="grid gap-4">
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (!detail.data) {
    return <QueryError error={detail.error} onRetry={() => void detail.refetch()} />;
  }

  const order = detail.data;
  return (
    <div className="grid gap-6">
      <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
        Order #{order.orderNumber}{' '}
        <Badge variant={ORDER_STATUS_BADGE[order.status]}>{ORDER_STATUS_LABEL[order.status]}</Badge>
      </h1>
      {order.status === 'PAYMENT_REVIEW' ? <AcceptPayment order={order} /> : null}
      <Summary order={order} />
      <Lines order={order} />
      <Refunds order={order} />
      <Payment order={order} />
      <Timeline order={order} />
    </div>
  );
}
