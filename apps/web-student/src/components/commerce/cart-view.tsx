'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CartChangedProblemSchema,
  CheckoutInProgressProblemSchema,
  CouponCodeSchema,
  ErrorCode,
  PriceChangedProblemSchema,
  sumMoney,
  type CartQuote,
  type CheckoutInProgressProblem,
  type Currency,
} from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@udemy/ui/components/dialog';
import { Input } from '@udemy/ui/components/input';
import { Label } from '@udemy/ui/components/label';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent, type ReactNode } from 'react';

import { CourseThumbnail } from '@/components/catalog/course-thumbnail';
import { EmptyState } from '@/components/catalog/catalog-states';
import { checkoutAttemptKey, clearCheckoutAttempt } from '@/lib/commerce/checkout-attempt';
import { redirectToCheckout } from '@/lib/commerce/checkout-redirect';
import {
  applyCoupon,
  cancelOrder,
  checkout,
  commerceKeys,
  fetchCart,
  fetchPublicPrices,
  removeCoupon,
  removeFromCart,
} from '@/lib/commerce/client';
import { discount, money, priceLabel } from '@/lib/commerce/format';
import { useGuestCart } from '@/lib/commerce/guest-cart';
import { useServerCart } from '@/lib/commerce/hooks';
import {
  CART_PATH,
  checkoutSuccessHref,
  courseHref,
  loginHref,
  VERIFY_EMAIL_PATH,
} from '@/lib/commerce/links';
import {
  CHECKOUT_MESSAGES,
  COUPON_MESSAGES,
  PURCHASE_BLOCK_SHORT,
  PURCHASE_MESSAGES,
} from '@/lib/commerce/messages';
import { hasCode, isApiError, problemMessage } from '@/lib/problem';

/**
 * `/cart` (design §10): the server cart for signed-in users, the `localStorage` guest cart for
 * visitors. Checkout creates an order and hands off to the hosted payment page (D1), but only
 * to an origin in `CHECKOUT_ALLOWED_ORIGINS` (`allowedOrigins`, from the server env).
 */
export function CartView({
  signedIn,
  allowedOrigins,
  couponCode = null,
}: {
  signedIn: boolean;
  allowedOrigins: readonly string[];
  /** `?coupon=` of the page: prefills the coupon field (never applied without a click). */
  couponCode?: string | null;
}) {
  return signedIn ? (
    <ServerCart allowedOrigins={allowedOrigins} couponCode={couponCode} />
  ) : (
    <GuestCart couponCode={couponCode} />
  );
}

/** `/cart`, keeping a `?coupon=` code (for the login redirect). */
function cartPath(couponCode: string | null): string {
  return couponCode === null ? CART_PATH : `${CART_PATH}?coupon=${encodeURIComponent(couponCode)}`;
}

function CartLayout({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
      <aside aria-label="Order summary" className="lg:sticky lg:top-6 lg:self-start">
        <div className="flex flex-col gap-4 rounded-lg border bg-card p-5 shadow-xs">{summary}</div>
      </aside>
    </div>
  );
}

function EmptyCart() {
  return (
    <EmptyState
      title="Your cart is empty"
      action={
        <Button asChild>
          <Link href="/courses">Browse courses</Link>
        </Button>
      }
    >
      Keep browsing to find a course.
    </EmptyState>
  );
}

function Totals({
  currency,
  list,
  discountAmount,
  total,
}: {
  currency: Currency;
  list: string;
  discountAmount: string;
  total: string;
}) {
  return (
    <dl data-testid="cart-totals" className="grid gap-1 text-sm">
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Original price</dt>
        <dd className="tabular-nums">{money(list, currency)}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Discounts</dt>
        <dd className="tabular-nums">{discount(discountAmount, currency)}</dd>
      </div>
      <div className="mt-2 flex justify-between gap-4 border-t pt-3 text-lg font-semibold">
        <dt>Total</dt>
        <dd data-testid="cart-total" className="tabular-nums">
          {money(total, currency)}
        </dd>
      </div>
    </dl>
  );
}

/* ---------------------------------------------------------------------- guest cart */

function GuestCart({ couponCode }: { couponCode: string | null }) {
  const guest = useGuestCart();
  const prices = useQuery({
    queryKey: commerceKeys.prices(guest.ids),
    queryFn: ({ signal }) => fetchPublicPrices(guest.ids, signal),
    enabled: guest.ids.length > 0,
    staleTime: 60_000,
  });

  if (guest.ids.length === 0) return <EmptyCart />;

  const priceById = new Map((prices.data ?? []).map((price) => [price.courseId, price]));
  const purchasable = guest.ids.flatMap((id) => {
    const price = priceById.get(id);
    return price && !price.isFree ? [price] : [];
  });
  const total = sumMoney(purchasable.map((price) => price.amount));

  return (
    <CartLayout
      summary={
        <>
          {prices.isSuccess ? (
            <Totals currency="USD" list={total} discountAmount="0.00" total={total} />
          ) : (
            <Skeleton className="h-20 w-full" />
          )}
          <p className="text-xs text-muted-foreground">
            {couponCode === null ? (
              'Prices are confirmed at checkout. Coupon codes can be applied after you log in.'
            ) : (
              <>
                Prices are confirmed at checkout. Log in to apply the code{' '}
                <span className="font-mono font-semibold">{couponCode}</span>.
              </>
            )}
          </p>
          <Button asChild size="lg" className="w-full">
            <Link href={loginHref(cartPath(couponCode))}>Log in to check out</Link>
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        {guest.ids.length} {guest.ids.length === 1 ? 'course' : 'courses'} in your cart
      </p>
      {prices.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{problemMessage(prices.error)}</AlertDescription>
        </Alert>
      ) : null}
      <ul aria-label="Cart items" className="flex flex-col divide-y rounded-lg border">
        {guest.ids.map((courseId) => {
          const price = priceById.get(courseId);
          // The live title and slug come with the public price; the label stored when the
          // course was added covers ids that are no longer for sale (no price item).
          const label = price ? { title: price.title, slug: price.slug } : guest.label(courseId);
          return (
            <li
              key={courseId}
              data-testid="cart-line"
              className="flex flex-wrap items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0">
                {label ? (
                  <Link
                    href={courseHref(label.slug)}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {label.title}
                  </Link>
                ) : (
                  <p className="font-medium">A course you picked</p>
                )}
              </div>
              <div className="flex items-center gap-4">
                <span className="tabular-nums">
                  {prices.isPending
                    ? '…'
                    : price
                      ? price.isFree
                        ? 'Free: enroll from its page'
                        : priceLabel(price.amount, price.currency)
                      : 'Not available'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => guest.remove(courseId)}
                  aria-label={`Remove ${label?.title ?? 'this course'}`}
                >
                  Remove
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </CartLayout>
  );
}

/* ---------------------------------------------------------------------- server cart */

type Notice = { variant: 'destructive' | 'warning' | 'info'; title?: string; body: ReactNode };

function ServerCart({
  allowedOrigins,
  couponCode,
}: {
  allowedOrigins: readonly string[];
  couponCode: string | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const cart = useServerCart(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [inProgress, setInProgress] = useState<CheckoutInProgressProblem | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);

  const setQuote = (quote: CartQuote) => queryClient.setQueryData(commerceKeys.cart, quote);
  const refreshStates = () =>
    queryClient.invalidateQueries({ queryKey: commerceKeys.purchaseStatesAll });

  const remove = useMutation({
    mutationFn: removeFromCart,
    onSuccess: (quote) => {
      setLineError(null);
      setQuote(quote);
      void refreshStates();
    },
    onError: (error) => setLineError(problemMessage(error, PURCHASE_MESSAGES)),
  });

  /** Sends the buyer to the payment page, or explains why not. */
  function handOff(orderId: string, checkoutUrl: string | null) {
    if (checkoutUrl === null) {
      setNotice({
        variant: 'warning',
        body: 'Your payment page is still being prepared. Please try again in a moment.',
      });
      return;
    }
    if (!redirectToCheckout(checkoutUrl, allowedOrigins)) {
      setNotice({
        variant: 'destructive',
        title: 'We could not open the payment page',
        body: (
          <>
            The payment link did not come from our payment provider, so we did not follow it.
            Nothing was charged. Contact support and mention order{' '}
            <span className="font-mono">{orderId}</span>.
          </>
        ),
      });
    }
  }

  const startCheckout = useMutation({
    mutationFn: async (quote: CartQuote) => {
      const key = checkoutAttemptKey(quote.fingerprint);
      return checkout(key, quote.totals.totalAmount);
    },
    onMutate: () => {
      setNotice(null);
      setInProgress(null);
    },
    onSuccess: (result) => {
      clearCheckoutAttempt();
      if (result.status === 'PAID') {
        // Zero-total order (100% coupon, D14): paid and enrolled already.
        void queryClient.invalidateQueries({ queryKey: commerceKeys.cart });
        void queryClient.invalidateQueries({ queryKey: commerceKeys.myLearning });
        void refreshStates();
        router.push(checkoutSuccessHref(result.orderId));
        return;
      }
      handOff(result.orderId, result.checkoutUrl);
    },
    onError: (error) => {
      // A definitive 4xx ends the attempt; 5xx and network errors keep the key (it resumes).
      if (isApiError(error) && error.status >= 400 && error.status < 500) clearCheckoutAttempt();
      const problem = isApiError(error) ? error.problem : null;

      const inProgressProblem = CheckoutInProgressProblemSchema.safeParse(problem);
      if (inProgressProblem.success) {
        setInProgress(inProgressProblem.data);
        return;
      }
      const changed =
        PriceChangedProblemSchema.safeParse(problem).data ??
        CartChangedProblemSchema.safeParse(problem).data;
      if (changed) {
        setQuote(changed.quote);
        setNotice({
          variant: 'warning',
          title:
            changed.code === ErrorCode.PriceChanged
              ? 'Prices in your cart have changed'
              : 'Your cart has changed',
          body:
            changed.code === ErrorCode.PriceChanged
              ? `Review the new total (${money(changed.quote.totals.totalAmount, changed.quote.currency)}) and check out again.`
              : 'Some courses can no longer be bought. Remove them and check out again.',
        });
        return;
      }
      if (hasCode(error, ErrorCode.EmailNotVerified)) {
        setNotice({
          variant: 'warning',
          title: 'Verify your email address',
          body: (
            <>
              We send receipts and refund updates by email, so paid checkout needs a verified
              address.{' '}
              <Link href={VERIFY_EMAIL_PATH} className="font-medium underline underline-offset-4">
                Resend the verification link
              </Link>
            </>
          ),
        });
        return;
      }
      if (hasCode(error, ErrorCode.CartEmpty) || hasCode(error, ErrorCode.IdempotencyKeyReused)) {
        void queryClient.invalidateQueries({ queryKey: commerceKeys.cart });
      }
      setNotice({ variant: 'destructive', body: problemMessage(error, CHECKOUT_MESSAGES) });
    },
  });

  const cancelAndRestart = useMutation({
    mutationFn: async (orderId: string) => {
      await cancelOrder(orderId);
      clearCheckoutAttempt();
      // The cart may have changed while the old checkout was open: quote it afresh.
      return queryClient.fetchQuery({
        queryKey: commerceKeys.cart,
        queryFn: ({ signal }) => fetchCart(signal),
        staleTime: 0,
      });
    },
    onSuccess: (quote) => {
      setInProgress(null);
      void queryClient.invalidateQueries({ queryKey: commerceKeys.ordersAll });
      if (quote.lines.length > 0 && quote.unavailable.length === 0) startCheckout.mutate(quote);
    },
    onError: (error) => {
      setInProgress(null);
      if (hasCode(error, ErrorCode.OrderNotCancelable) && inProgress) {
        setNotice({
          variant: 'info',
          title: 'Your previous payment went through',
          body: (
            <Link
              href={checkoutSuccessHref(inProgress.orderId)}
              className="font-medium underline underline-offset-4"
            >
              See that order
            </Link>
          ),
        });
        return;
      }
      setNotice({ variant: 'destructive', body: problemMessage(error, CHECKOUT_MESSAGES) });
    },
  });

  if (cart.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <span className="sr-only" role="status">
          Loading your cart…
        </span>
      </div>
    );
  }
  if (cart.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>We could not load your cart</AlertTitle>
        <AlertDescription>
          <p>{problemMessage(cart.error)}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void cart.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const quote = cart.data;
  if (quote.itemCount === 0) {
    return (
      <div className="flex flex-col gap-4">
        {notice ? <NoticeAlert notice={notice} /> : null}
        <EmptyCart />
      </div>
    );
  }

  const busy = startCheckout.isPending || cancelAndRestart.isPending;
  const canCheckout = quote.lines.length > 0 && quote.unavailable.length === 0;

  return (
    <>
      <CartLayout
        summary={
          <>
            <Totals
              currency={quote.currency}
              list={quote.totals.listAmount}
              discountAmount={quote.totals.discountAmount}
              total={quote.totals.totalAmount}
            />
            <CouponForm quote={quote} onQuote={setQuote} initialCode={couponCode} />
            <Button
              size="lg"
              className="w-full"
              disabled={!canCheckout || busy}
              aria-busy={busy || undefined}
              onClick={() => startCheckout.mutate(quote)}
            >
              {busy ? <Spinner className="size-4" /> : null}
              Checkout
            </Button>
            {!canCheckout && quote.unavailable.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Remove the courses that are no longer available to check out.
              </p>
            ) : null}
          </>
        }
      >
        {notice ? <NoticeAlert notice={notice} /> : null}
        {lineError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{lineError}</AlertDescription>
          </Alert>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {quote.itemCount} {quote.itemCount === 1 ? 'course' : 'courses'} in your cart
        </p>
        <ul aria-label="Cart items" className="flex flex-col divide-y rounded-lg border">
          {quote.lines.map((line) => (
            <li
              key={line.courseId}
              data-testid="cart-line"
              className="flex flex-wrap items-start gap-4 p-4 sm:flex-nowrap"
            >
              <div className="w-32 shrink-0 overflow-hidden rounded-md">
                <CourseThumbnail
                  courseId={line.courseId}
                  title={line.title}
                  hasThumbnail={line.hasThumbnail}
                  sizes="8rem"
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Link
                  href={courseHref(line.slug)}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {line.title}
                </Link>
                {line.instructor ? (
                  <p className="text-xs text-muted-foreground">{line.instructor.displayName}</p>
                ) : null}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto self-start p-0"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(line.courseId)}
                  aria-label={`Remove ${line.title}`}
                >
                  Remove
                </Button>
              </div>
              <div className="flex flex-col items-end gap-0.5 text-sm tabular-nums">
                <span data-testid="line-final" className="text-base font-semibold">
                  {money(line.finalAmount, quote.currency)}
                </span>
                {line.discountAmount !== '0.00' ? (
                  <>
                    <s data-testid="line-list" className="text-muted-foreground">
                      {money(line.listAmount, quote.currency)}
                    </s>
                    <span data-testid="line-discount" className="text-xs text-emerald-700">
                      {discount(line.discountAmount, quote.currency)}
                    </span>
                  </>
                ) : null}
              </div>
            </li>
          ))}
          {quote.unavailable.map((line) => (
            <li
              key={line.courseId}
              data-testid="cart-unavailable"
              className="flex flex-wrap items-center justify-between gap-4 bg-muted/40 p-4"
            >
              <div className="min-w-0">
                <p className="font-medium">{line.title ?? 'A course that no longer exists'}</p>
                <p className="text-xs text-muted-foreground">
                  Not available: {PURCHASE_BLOCK_SHORT[line.reason]}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(line.courseId)}
                aria-label={`Remove ${line.title ?? 'this course'}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      </CartLayout>

      <Dialog open={inProgress !== null} onOpenChange={(open) => !open && setInProgress(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>You have a checkout in progress</DialogTitle>
            <DialogDescription>
              You started paying for an order and have not finished. Resume that payment, or cancel
              it and check out your current cart instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={cancelAndRestart.isPending}
              aria-busy={cancelAndRestart.isPending || undefined}
              onClick={() => inProgress && cancelAndRestart.mutate(inProgress.orderId)}
            >
              {cancelAndRestart.isPending ? <Spinner className="size-4" /> : null}
              Cancel and start over
            </Button>
            <Button
              disabled={cancelAndRestart.isPending}
              onClick={() => {
                if (!inProgress) return;
                const { orderId, checkoutUrl } = inProgress;
                setInProgress(null);
                handOff(orderId, checkoutUrl);
              }}
            >
              Resume payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NoticeAlert({ notice }: { notice: Notice }) {
  return (
    <Alert variant={notice.variant} role={notice.variant === 'destructive' ? 'alert' : 'status'}>
      {notice.title ? <AlertTitle>{notice.title}</AlertTitle> : null}
      <AlertDescription>
        <p>{notice.body}</p>
      </AlertDescription>
    </Alert>
  );
}

/* ---------------------------------------------------------------------- coupon */

function CouponForm({
  quote,
  onQuote,
  initialCode,
}: {
  quote: CartQuote;
  onQuote: (quote: CartQuote) => void;
  /** Prefill (`?coupon=`); applying it is still the buyer's click. */
  initialCode: string | null;
}) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [code, setCode] = useState(initialCode ?? '');
  const [error, setError] = useState<string | null>(null);

  const apply = useMutation({
    mutationFn: applyCoupon,
    onSuccess: (next) => {
      setError(null);
      setCode('');
      onQuote(next);
    },
    onError: (failure) => setError(problemMessage(failure, COUPON_MESSAGES)),
  });
  const remove = useMutation({
    mutationFn: removeCoupon,
    onSuccess: (next) => {
      setError(null);
      onQuote(next);
    },
    onError: (failure) => setError(problemMessage(failure)),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = CouponCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError('Enter a code of 4–20 letters, digits, "_" or "-".');
      return;
    }
    apply.mutate(parsed.data);
  }

  if (quote.coupon) {
    const { coupon } = quote;
    return (
      <div className="flex flex-col gap-2 rounded-md border border-dashed p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <p>
            <span className="font-mono font-semibold">{coupon.code}</span>{' '}
            {coupon.applied ? 'is applied' : 'does not apply'}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
            aria-label={`Remove code ${coupon.code}`}
          >
            Remove
          </Button>
        </div>
        {!coupon.applied && coupon.problem ? (
          <p data-testid="coupon-problem" className="text-xs text-muted-foreground">
            {(COUPON_MESSAGES[coupon.problem] as string | undefined) ??
              'This code no longer applies.'}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2">
      <Label htmlFor={inputId}>Coupon code</Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={apply.isPending}
          aria-busy={apply.isPending || undefined}
        >
          Apply
        </Button>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
