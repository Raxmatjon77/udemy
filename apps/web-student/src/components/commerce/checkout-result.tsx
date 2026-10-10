'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorCode, type OrderDetail, type OrderStatus } from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Spinner } from '@udemy/ui/components/spinner';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cancelOrder, commerceKeys, fetchMyLearning, fetchOrder } from '@/lib/commerce/client';
import { money } from '@/lib/commerce/format';
import {
  CART_PATH,
  checkoutSuccessHref,
  learnHref,
  orderHref,
  receiptHref,
} from '@/lib/commerce/links';
import { hasCode, isApiError, problemMessage } from '@/lib/problem';

/** Order states the success page stops polling at (only PENDING_PAYMENT can still change). */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'PAID',
  'PAYMENT_REVIEW',
  'EXPIRED',
  'CANCELED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);

/** Design §10: every 1.5 s, up to 60 s. */
export const ORDER_POLL_INTERVAL_MS = 1_500;
export const ORDER_POLL_TIMEOUT_MS = 60_000;

function ResultCard({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section
      data-testid={testId}
      aria-labelledby="checkout-result-title"
      className="flex flex-col gap-4 rounded-lg border bg-card p-6 shadow-xs"
    >
      <h1 id="checkout-result-title" className="text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      {children}
    </section>
  );
}

/**
 * `/checkout/success?orderId=`: the hosted checkout (or the zero-total path) lands here. The
 * order becomes PAID when the webhook arrives, so the page polls `GET /me/orders/:id` until a
 * terminal state, for at most `pollTimeoutMs`.
 */
export function CheckoutSuccess({
  orderId,
  pollIntervalMs = ORDER_POLL_INTERVAL_MS,
  pollTimeoutMs = ORDER_POLL_TIMEOUT_MS,
}: {
  orderId: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}) {
  const queryClient = useQueryClient();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), pollTimeoutMs);
    return () => clearTimeout(timer);
  }, [pollTimeoutMs]);

  const order = useQuery({
    queryKey: commerceKeys.order(orderId),
    queryFn: ({ signal }) => fetchOrder(orderId, signal),
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL_ORDER_STATUSES.has(status)) return false;
      const error = query.state.error;
      if (isApiError(error) && error.status < 500) return false;
      return timedOut ? false : pollIntervalMs;
    },
    // Keep polling through a background tab: the buyer is waiting for this page.
    refetchIntervalInBackground: true,
    retry: false,
  });

  const status = order.data?.status;
  const paid = status === 'PAID';

  // Paid: the cart lost these items and the purchase states changed; refresh them once.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!paid || refreshed.current) return;
    refreshed.current = true;
    void queryClient.invalidateQueries({ queryKey: commerceKeys.cart });
    void queryClient.invalidateQueries({ queryKey: commerceKeys.purchaseStatesAll });
    void queryClient.invalidateQueries({ queryKey: commerceKeys.myLearning });
    void queryClient.invalidateQueries({ queryKey: commerceKeys.ordersAll, exact: false });
  }, [paid, queryClient]);

  // Order lines carry no slug: resolve the course links from "My learning" (first page).
  const learning = useQuery({
    queryKey: [...commerceKeys.myLearning, 'first-page'],
    queryFn: ({ signal }) => fetchMyLearning(null, signal),
    enabled: paid,
  });
  const slugOf = new Map((learning.data?.items ?? []).map((card) => [card.courseId, card.slug]));

  if (order.isError && !order.data) {
    return (
      <ResultCard testId="checkout-error" title="We could not find this order">
        <p className="text-sm text-muted-foreground">
          {hasCode(order.error, ErrorCode.OrderNotFound)
            ? 'This order does not exist or belongs to another account.'
            : problemMessage(order.error)}
        </p>
        <ResultLinks>
          <Button asChild variant="outline">
            <Link href="/account/orders">Your orders</Link>
          </Button>
        </ResultLinks>
      </ResultCard>
    );
  }

  if (!order.data || status === 'PENDING_PAYMENT') {
    if (timedOut) {
      return (
        <ResultCard testId="checkout-processing" title="Your payment is processing">
          <p className="text-sm text-muted-foreground">
            This is taking longer than usual. We&apos;ll email your receipt as soon as the payment
            is confirmed, and the courses will appear in My learning.
          </p>
          <ResultLinks>
            <Button asChild variant="outline">
              <Link href={orderHref(orderId)}>View order</Link>
            </Button>
          </ResultLinks>
        </ResultCard>
      );
    }
    return (
      <ResultCard testId="checkout-pending" title="Confirming your payment…">
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Hang tight, this usually takes a few seconds.
        </p>
      </ResultCard>
    );
  }

  const detail = order.data;
  if (paid) {
    return (
      <ResultCard testId="checkout-paid" title="You're enrolled">
        <p className="text-sm text-muted-foreground">
          Payment received for order #{detail.orderNumber} (
          {money(detail.totalAmount, detail.currency)}). A receipt is on its way to your inbox.
        </p>
        <ul aria-label="Your new courses" className="flex flex-col divide-y rounded-md border">
          {detail.lines.map((line) => {
            const slug = slugOf.get(line.courseId);
            return (
              <li key={line.id} className="flex items-center justify-between gap-4 p-3">
                <span className="font-medium">{line.courseTitle}</span>
                {slug ? (
                  <Button asChild size="sm">
                    <Link href={learnHref(slug)}>Go to course</Link>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <ResultLinks>
          <Button asChild>
            <Link href="/my-learning">My learning</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={receiptHref(detail.id)}>View receipt</Link>
          </Button>
        </ResultLinks>
      </ResultCard>
    );
  }

  return <ClosedOrder order={detail} />;
}

function ClosedOrder({ order }: { order: OrderDetail }) {
  switch (order.status) {
    case 'EXPIRED':
      return (
        <ResultCard testId="checkout-expired" title="This checkout expired">
          <p className="text-sm text-muted-foreground">
            The payment was not completed in time, so nothing was charged. Your cart is still there.
          </p>
          <ResultLinks>
            <Button asChild>
              <Link href={CART_PATH}>Back to cart</Link>
            </Button>
          </ResultLinks>
        </ResultCard>
      );
    case 'CANCELED':
      return (
        <ResultCard testId="checkout-canceled" title="This checkout was canceled">
          <p className="text-sm text-muted-foreground">Nothing was charged.</p>
          <ResultLinks>
            <Button asChild>
              <Link href={CART_PATH}>Back to cart</Link>
            </Button>
          </ResultLinks>
        </ResultCard>
      );
    case 'PAYMENT_REVIEW':
      return (
        <ResultCard testId="checkout-review" title="Your payment is under review">
          <p className="text-sm text-muted-foreground">
            We received your payment but need to check it before giving you access. We&apos;ll email
            you once it is done.
          </p>
          <ResultLinks>
            <Button asChild variant="outline">
              <Link href={orderHref(order.id)}>View order</Link>
            </Button>
          </ResultLinks>
        </ResultCard>
      );
    default:
      return (
        <ResultCard testId="checkout-closed" title="Order details">
          <ResultLinks>
            <Button asChild variant="outline">
              <Link href={orderHref(order.id)}>View order</Link>
            </Button>
          </ResultLinks>
        </ResultCard>
      );
  }
}

function ResultLinks({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

/**
 * `/checkout/cancel?orderId=`: the buyer left the hosted page. Cancels the order (idempotent;
 * it releases the coupon reservation and unblocks a new checkout) and links back to the cart.
 */
export function CheckoutCancel({ orderId }: { orderId: string }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => cancelOrder(orderId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: commerceKeys.ordersAll });
    },
  });
  const { mutate } = cancel;
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);

  if (cancel.isError && hasCode(cancel.error, ErrorCode.OrderNotCancelable)) {
    return (
      <ResultCard testId="cancel-too-late" title="Your payment already went through">
        <p className="text-sm text-muted-foreground">
          The order could not be canceled because the payment was completed.
        </p>
        <ResultLinks>
          <Button asChild>
            <Link href={checkoutSuccessHref(orderId)}>See your order</Link>
          </Button>
        </ResultLinks>
      </ResultCard>
    );
  }

  return (
    <ResultCard testId="checkout-cancel" title="Checkout canceled">
      {cancel.isPending || cancel.isIdle ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Canceling your order…
        </p>
      ) : cancel.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>We could not cancel the order</AlertTitle>
          <AlertDescription>
            {problemMessage(cancel.error)} It will expire on its own if you do not pay.
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground">
          You left the payment page, so nothing was charged. Your courses are still in your cart.
        </p>
      )}
      <ResultLinks>
        <Button asChild>
          <Link href={CART_PATH}>Back to cart</Link>
        </Button>
      </ResultLinks>
    </ResultCard>
  );
}

/** A success/cancel link without a (valid) order id. */
export function MissingOrder() {
  return (
    <ResultCard testId="checkout-missing" title="No order to show">
      <p className="text-sm text-muted-foreground">This link is missing its order number.</p>
      <ResultLinks>
        <Button asChild variant="outline">
          <Link href="/account/orders">Your orders</Link>
        </Button>
      </ResultLinks>
    </ResultCard>
  );
}
