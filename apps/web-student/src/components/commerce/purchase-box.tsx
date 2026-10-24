'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PublicPrice, PurchaseState } from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { addToCart, commerceKeys, enrollFree } from '@/lib/commerce/client';
import { useGuestCart } from '@/lib/commerce/guest-cart';
import { usePurchaseState } from '@/lib/commerce/hooks';
import { CART_PATH, courseHref, learnHref, loginHref } from '@/lib/commerce/links';
import { PURCHASE_MESSAGES } from '@/lib/commerce/messages';
import { problemMessage } from '@/lib/problem';

import { PriceTag } from './price-tag';

/**
 * What the landing page offers this visitor (design §10 "Landing"). Exactly one state:
 */
export type PurchaseBoxState =
  'loading' | 'owner' | 'enrolled' | 'not_for_sale' | 'free' | 'in_cart' | 'add_to_cart';

/**
 * The state, in precedence order: the owner and enrolled students first (whatever the price),
 * then "not for sale" (no price, D16; for signed-in viewers also the live `forSale` of their
 * purchase state, which wins over the server-rendered price), "free" (D14), and for a paid
 * course the cart.
 */
export function purchaseBoxState(input: {
  price: PublicPrice | null;
  /** Signed-in viewers only; null for guests. */
  purchase: PurchaseState | null;
  inGuestCart: boolean;
}): Exclude<PurchaseBoxState, 'loading'> {
  const { price, purchase } = input;
  if (purchase?.isOwner) return 'owner';
  if (purchase?.enrolled) return 'enrolled';
  if (price === null || purchase?.forSale === false) return 'not_for_sale';
  if (price.isFree) return 'free';
  if (purchase ? purchase.inCart : input.inGuestCart) return 'in_cart';
  return 'add_to_cart';
}

export interface PurchaseBoxCourse {
  id: string;
  slug: string;
  title: string;
}

/**
 * The landing page's purchase island. Guests: the price from the server render and the guest
 * cart in `localStorage`; signed in: `GET /me/purchase-states` for this course.
 */
export function PurchaseBox({
  course,
  price,
  signedIn,
}: {
  course: PurchaseBoxCourse;
  /** Null: no price (not for sale). */
  price: PublicPrice | null;
  signedIn: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const guest = useGuestCart();
  const purchase = usePurchaseState(course.id, signedIn);
  const [message, setMessage] = useState<string | null>(null);

  const refreshStates = () =>
    queryClient.invalidateQueries({ queryKey: commerceKeys.purchaseStatesAll });

  const add = useMutation({
    mutationFn: () => addToCart(course.id),
    onSuccess: (quote) => {
      queryClient.setQueryData(commerceKeys.cart, quote);
      void refreshStates();
    },
    onError: (error) => {
      setMessage(problemMessage(error, PURCHASE_MESSAGES));
      void refreshStates();
    },
  });

  const enroll = useMutation({
    mutationFn: () => enrollFree(course.id),
    onSuccess: () => {
      void refreshStates();
      void queryClient.invalidateQueries({ queryKey: commerceKeys.myLearning });
      router.push(learnHref(course.id));
    },
    onError: (error) => {
      setMessage(problemMessage(error, PURCHASE_MESSAGES));
      void refreshStates();
    },
  });

  const state: PurchaseBoxState =
    signedIn && purchase.isPending
      ? 'loading'
      : purchaseBoxState({
          price,
          purchase: signedIn ? (purchase.data ?? null) : null,
          inGuestCart: guest.has(course.id),
        });

  function addToGuestCart(then?: () => void) {
    const result = guest.add(course.id, { title: course.title, slug: course.slug });
    if (result === 'full') setMessage(PURCHASE_MESSAGES.cart_full as string);
    else if (result === 'unavailable') {
      setMessage('Your browser is blocking site storage. Log in to use the cart.');
    } else then?.();
  }

  function onAdd(buyNow: boolean) {
    setMessage(null);
    const goToCart = () => {
      if (buyNow) router.push(CART_PATH);
    };
    if (!signedIn) addToGuestCart(goToCart);
    else add.mutate(undefined, { onSuccess: goToCart });
  }

  return (
    <div data-testid="purchase-box" data-state={state} className="flex flex-col gap-3">
      {state === 'loading' ? (
        <>
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-10 w-full" />
          <span className="sr-only" role="status">
            Loading your enrollment status…
          </span>
        </>
      ) : null}

      {state !== 'loading' && state !== 'owner' && state !== 'enrolled' ? (
        <PriceTag price={price} size="lg" />
      ) : null}

      {state === 'owner' ? (
        <>
          <p className="font-semibold">You&apos;re the instructor</p>
          <p className="text-sm text-muted-foreground">
            This is your own course. Manage it in the instructor app.
          </p>
        </>
      ) : null}

      {state === 'enrolled' ? (
        <>
          <p className="font-semibold">You&apos;re enrolled</p>
          <Button asChild size="lg" className="w-full">
            <Link href={learnHref(course.id)}>Go to course</Link>
          </Button>
        </>
      ) : null}

      {state === 'not_for_sale' ? (
        <>
          <Button size="lg" disabled aria-describedby="purchase-note" className="w-full">
            Not available for enrollment yet
          </Button>
          <p id="purchase-note" className="text-xs text-muted-foreground">
            This course is not for sale yet. You can already watch the free previews.
          </p>
        </>
      ) : null}

      {state === 'free' ? (
        signedIn ? (
          <Button
            size="lg"
            className="w-full"
            disabled={enroll.isPending || enroll.isSuccess}
            aria-busy={enroll.isPending || undefined}
            onClick={() => {
              setMessage(null);
              enroll.mutate();
            }}
          >
            {enroll.isPending ? <Spinner className="size-4" /> : null}
            Enroll for free
          </Button>
        ) : (
          <Button asChild size="lg" className="w-full">
            <Link href={loginHref(courseHref(course.slug))}>Enroll for free</Link>
          </Button>
        )
      ) : null}

      {state === 'in_cart' ? (
        <Button asChild size="lg" className="w-full">
          <Link href={CART_PATH}>Go to cart</Link>
        </Button>
      ) : null}

      {state === 'add_to_cart' ? (
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="w-full"
            disabled={add.isPending}
            aria-busy={add.isPending || undefined}
            onClick={() => onAdd(false)}
          >
            {add.isPending ? <Spinner className="size-4" /> : null}
            Add to cart
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="w-full"
            disabled={add.isPending}
            onClick={() => onAdd(true)}
          >
            Buy now
          </Button>
        </div>
      ) : null}

      {signedIn && purchase.isError ? (
        <p className="text-xs text-muted-foreground">
          We could not check whether you already own this course.{' '}
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            onClick={() => void purchase.refetch()}
          >
            Try again
          </button>
        </p>
      ) : null}

      {message ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
