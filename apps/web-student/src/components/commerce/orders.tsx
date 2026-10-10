'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  ErrorCode,
  REFUND_REASON_LABELS,
  STUDENT_REFUND_REASON_CODES,
  type OrderDetail,
  type OrderLine,
  type OrderStatus,
  type OrderSummaryPage,
  type Refund,
  type StudentRefundReasonCode,
} from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@udemy/ui/components/dialog';
import { FormField } from '@udemy/ui/components/form-field';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import { Textarea } from '@udemy/ui/components/textarea';
import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';

import { EmptyState } from '@/components/catalog/catalog-states';
import { redirectToCheckout } from '@/lib/commerce/checkout-redirect';
import {
  cancelOrder,
  commerceKeys,
  fetchOrder,
  fetchOrders,
  requestRefund,
} from '@/lib/commerce/client';
import { discount, money, ORDER_STATUS_LABELS, REFUND_STATUS_LABELS } from '@/lib/commerce/format';
import { orderHref, receiptHref } from '@/lib/commerce/links';
import { CHECKOUT_MESSAGES, REFUND_BLOCK_MESSAGES, REFUND_MESSAGES } from '@/lib/commerce/messages';
import { formatDate, formatDateTime } from '@/lib/format';
import { hasCode, problemMessage } from '@/lib/problem';

const STATUS_VARIANT: Record<OrderStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  PENDING_PAYMENT: 'secondary',
  PAID: 'default',
  PAYMENT_REVIEW: 'secondary',
  EXPIRED: 'outline',
  CANCELED: 'outline',
  PARTIALLY_REFUNDED: 'secondary',
  REFUNDED: 'outline',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <Badge data-testid="order-status" variant={STATUS_VARIANT[status]}>
      {ORDER_STATUS_LABELS[status]}
    </Badge>
  );
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertDescription>
        <p>
          {problemMessage(error, { [ErrorCode.OrderNotFound]: 'We could not find this order.' })}
        </p>
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/* ---------------------------------------------------------------------- list */

/** `/account/orders`: the student's orders, newest first, with keyset "Load more". */
export function OrdersList() {
  const query = useInfiniteQuery<
    OrderSummaryPage,
    Error,
    InfiniteData<OrderSummaryPage, string | null>,
    typeof commerceKeys.orders,
    string | null
  >({
    queryKey: commerceKeys.orders,
    queryFn: ({ pageParam, signal }) => fetchOrders(pageParam, signal),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
  });

  if (query.isPending) return <Skeleton className="h-40 w-full" />;
  if (query.isError) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;

  const orders = query.data.pages.flatMap((page) => page.items);
  if (orders.length === 0) {
    return (
      <EmptyState
        title="No orders yet"
        action={
          <Button asChild>
            <Link href="/courses">Browse courses</Link>
          </Button>
        }
      >
        Your purchases and receipts will show up here.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Orders" className="flex flex-col divide-y rounded-lg border">
        {orders.map((order) => (
          <li key={order.id} data-testid="order-row" className="relative flex flex-col gap-1 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link
                href={orderHref(order.id)}
                className="font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
              >
                Order #{order.orderNumber}
              </Link>
              <span className="font-semibold tabular-nums">
                {money(order.totalAmount, order.currency)}
              </span>
            </div>
            <p className="line-clamp-1 text-sm">{order.courseTitles.join(', ')}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <time dateTime={order.placedAt}>{formatDate(order.placedAt)}</time>
              <OrderStatusBadge status={order.status} />
            </div>
          </li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? <Spinner className="size-4" /> : null}
          Load more
        </Button>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------- detail */

/** `/account/orders/[id]`: lines, totals, refund state per line and the actions. */
export function OrderDetailView({
  orderId,
  allowedOrigins,
}: {
  orderId: string;
  allowedOrigins: readonly string[];
}) {
  const queryClient = useQueryClient();
  const order = useQuery({
    queryKey: commerceKeys.order(orderId),
    queryFn: ({ signal }) => fetchOrder(orderId, signal),
  });
  const [notice, setNotice] = useState<{ variant: 'success' | 'destructive'; body: string } | null>(
    null,
  );

  const cancel = useMutation({
    mutationFn: () => cancelOrder(orderId),
    onSuccess: (detail) => {
      queryClient.setQueryData(commerceKeys.order(orderId), detail);
      void queryClient.invalidateQueries({ queryKey: commerceKeys.orders });
      setNotice({ variant: 'success', body: 'The order was canceled. Nothing was charged.' });
    },
    onError: (error) =>
      setNotice({ variant: 'destructive', body: problemMessage(error, CHECKOUT_MESSAGES) }),
  });

  if (order.isPending) return <Skeleton className="h-64 w-full" />;
  if (order.isError) return <LoadError error={order.error} onRetry={() => void order.refetch()} />;

  const detail = order.data;
  const pending = detail.status === 'PENDING_PAYMENT';

  function onRefunded(refund: Refund) {
    void queryClient.invalidateQueries({ queryKey: commerceKeys.order(orderId) });
    void queryClient.invalidateQueries({ queryKey: commerceKeys.orders });
    void queryClient.invalidateQueries({ queryKey: commerceKeys.myLearning });
    void queryClient.invalidateQueries({ queryKey: commerceKeys.purchaseStatesAll });
    setNotice({
      variant: 'success',
      body:
        refund.status === 'REQUESTED'
          ? `Your refund request for "${refund.courseTitle}" is under review. We'll email you when it is decided.`
          : `Your refund for "${refund.courseTitle}" is approved. Access to the course has ended, and ${money(refund.amount, refund.currency)} goes back to your original payment method.`,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Order #{detail.orderNumber}</h1>
          <OrderStatusBadge status={detail.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          Placed <time dateTime={detail.placedAt}>{formatDateTime(detail.placedAt)}</time>
          {detail.paidAt ? (
            <>
              {' '}
              · Paid <time dateTime={detail.paidAt}>{formatDateTime(detail.paidAt)}</time>
            </>
          ) : null}
        </p>
      </header>

      {notice ? (
        <Alert
          variant={notice.variant}
          role={notice.variant === 'destructive' ? 'alert' : 'status'}
        >
          <AlertDescription>{notice.body}</AlertDescription>
        </Alert>
      ) : null}

      {pending ? (
        <Alert variant="warning">
          <AlertTitle>Awaiting payment</AlertTitle>
          <AlertDescription>
            <p>This order is not paid yet.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {detail.checkoutUrl ? (
                <Button
                  size="sm"
                  onClick={() => {
                    if (!redirectToCheckout(detail.checkoutUrl ?? '', allowedOrigins)) {
                      setNotice({
                        variant: 'destructive',
                        body: 'The payment link did not come from our payment provider, so we did not follow it.',
                      });
                    }
                  }}
                >
                  Resume payment
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel order
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <ul aria-label="Order items" className="flex flex-col divide-y rounded-lg border">
        {detail.lines.map((line) => (
          <OrderLineRow key={line.id} order={detail} line={line} onRefunded={onRefunded} />
        ))}
      </ul>

      <dl className="grid max-w-sm gap-1 self-end text-sm">
        <Row label="Original price">{money(detail.subtotalAmount, detail.currency)}</Row>
        <Row label="Discounts">{discount(detail.discountAmount, detail.currency)}</Row>
        <Row label="Total" strong>
          {money(detail.totalAmount, detail.currency)}
        </Row>
        {detail.refundedAmount !== '0.00' ? (
          <Row label="Refunded">{money(detail.refundedAmount, detail.currency)}</Row>
        ) : null}
      </dl>

      <div className="flex flex-wrap gap-2">
        {detail.paidAt ? (
          <Button asChild variant="outline">
            <Link href={receiptHref(detail.id)}>View receipt</Link>
          </Button>
        ) : null}
        <Button asChild variant="ghost">
          <Link href="/account/orders">All orders</Link>
        </Button>
      </div>
    </div>
  );
}

function Row({
  label,
  strong,
  children,
}: {
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        strong
          ? 'mt-1 flex justify-between gap-6 border-t pt-2 font-semibold'
          : 'flex justify-between gap-6'
      }
    >
      <dt className={strong ? undefined : 'text-muted-foreground'}>{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

function OrderLineRow({
  order,
  line,
  onRefunded,
}: {
  order: OrderDetail;
  line: OrderLine;
  onRefunded: (refund: Refund) => void;
}) {
  const { refund } = line;
  return (
    <li data-testid="order-line" className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium">{line.courseTitle}</p>
          {line.instructor ? (
            <p className="text-xs text-muted-foreground">{line.instructor.displayName}</p>
          ) : null}
          {line.couponCode ? (
            <p className="text-xs text-muted-foreground">
              Code <span className="font-mono">{line.couponCode}</span>
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-end text-sm tabular-nums">
          <span className="font-semibold">{money(line.finalAmount, order.currency)}</span>
          {line.discountAmount !== '0.00' ? (
            <s className="text-xs text-muted-foreground">
              {money(line.listAmount, order.currency)}
            </s>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {refund.status ? (
          <Badge data-testid="refund-status" variant="secondary">
            {REFUND_STATUS_LABELS[refund.status]}
          </Badge>
        ) : null}
        {refund.eligible ? (
          <>
            <RefundDialog order={order} line={line} onRefunded={onRefunded} />
            {refund.refundableUntil ? (
              <span className="text-xs text-muted-foreground">
                Refundable until{' '}
                <time dateTime={refund.refundableUntil}>{formatDate(refund.refundableUntil)}</time>
              </span>
            ) : null}
          </>
        ) : refund.reason && refund.reason !== ErrorCode.RefundAlreadyRequested && order.paidAt ? (
          <span data-testid="refund-blocked" className="text-xs text-muted-foreground">
            {refund.reason === ErrorCode.RefundWindowClosed && refund.refundableUntil
              ? `The refund window closed on ${formatDate(refund.refundableUntil)}.`
              : REFUND_BLOCK_MESSAGES[refund.reason]}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------------- refund dialog */

const REFUND_COMMENT_MAX = 1000;

export function RefundDialog({
  order,
  line,
  onRefunded,
}: {
  order: OrderDetail;
  line: OrderLine;
  onRefunded: (refund: Refund) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<StudentRefundReasonCode | ''>('');
  const [comment, setComment] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const idBase = `refund-${line.id}`;

  const submit = useMutation({
    mutationFn: (code: StudentRefundReasonCode) =>
      requestRefund(order.id, {
        orderLineId: line.id,
        reasonCode: code,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      }),
    onSuccess: (refund) => {
      setOpen(false);
      onRefunded(refund);
    },
    onError: (error) => {
      setFormError(problemMessage(error, REFUND_MESSAGES));
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    if (reasonCode === '') {
      setFieldError('Choose a reason.');
      return;
    }
    if (comment.trim().length > REFUND_COMMENT_MAX) {
      setFieldError(null);
      setFormError(`Keep the comment under ${REFUND_COMMENT_MAX} characters.`);
      return;
    }
    setFieldError(null);
    submit.mutate(reasonCode);
  }

  const until = line.refund.refundableUntil;
  const closedAlready = hasCode(submit.error, ErrorCode.RefundWindowClosed);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setFormError(null);
          setFieldError(null);
          submit.reset();
        }
      }}
    >
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Request refund
      </Button>
      <DialogContent>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Request a refund</DialogTitle>
            <DialogDescription>
              {line.courseTitle}: {money(line.finalAmount, order.currency)}.{' '}
              {until ? `Refunds are possible until ${formatDate(until)}. ` : ''}
              Access to the course ends when the refund is approved.
            </DialogDescription>
          </DialogHeader>

          {formError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <FormField id={`${idBase}-reason`} label="Reason" error={fieldError ?? undefined}>
            {(field) => (
              <NativeSelect
                {...field}
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value as StudentRefundReasonCode)}
              >
                <option value="">Choose a reason</option>
                {STUDENT_REFUND_REASON_CODES.map((code) => (
                  <option key={code} value={code}>
                    {REFUND_REASON_LABELS[code]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>

          <FormField
            id={`${idBase}-comment`}
            label="Comment"
            hint="Optional"
            description={`${comment.trim().length}/${REFUND_COMMENT_MAX}`}
          >
            {(field) => (
              <Textarea
                {...field}
                rows={4}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            )}
          </FormField>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={submit.isPending || closedAlready}
              aria-busy={submit.isPending || undefined}
            >
              {submit.isPending ? <Spinner className="size-4" /> : null}
              Request refund
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
