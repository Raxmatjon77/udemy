'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorCode, type MergeSkipReason, type PurchaseState } from '@udemy/contracts';
import { useCallback, useEffect, useState } from 'react';

import { hasCode, isApiError } from '../problem';
import { commerceKeys, fetchCart, fetchPurchaseStates, mergeGuestCart } from './client';
import { clearGuestCart, guestCartLabel, useGuestCart } from './guest-cart';

/** The signed-in user's server cart (`GET /me/cart`), shared by the header and `/cart`. */
export function useServerCart(enabled: boolean) {
  return useQuery({
    queryKey: commerceKeys.cart,
    queryFn: ({ signal }) => fetchCart(signal),
    enabled,
  });
}

/** `GET /me/purchase-states` for one course (signed-in only). */
export function usePurchaseState(courseId: string, enabled: boolean) {
  return useQuery<PurchaseState | null>({
    queryKey: commerceKeys.purchaseStates([courseId]),
    queryFn: async ({ signal }) =>
      (await fetchPurchaseStates([courseId], signal)).find((s) => s.courseId === courseId) ?? null,
    enabled,
    // Enrollment and cart state change through this tab's own mutations (which invalidate it)
    // or another tab's; a short stale time keeps a back-navigation honest.
    staleTime: 5_000,
  });
}

/** How many items the header badge shows: the server cart when signed in, else the guest cart. */
export function useCartCount(signedIn: boolean): number | null {
  const guest = useGuestCart();
  const cart = useServerCart(signedIn);
  if (!signedIn) return guest.ids.length;
  return cart.data?.itemCount ?? null;
}

export interface MergeNotice {
  /** Ids the server did not add, with a display title when one was stored. */
  skipped: { courseId: string; reason: MergeSkipReason; title: string | null }[];
  /** The merge failed as a whole (e.g. 422 `cart_full`). */
  error: string | null;
}

// One merge per page load: React StrictMode runs effects twice, and several components could
// mount the hook. Reset when the merge settles, so a failed (network) merge retries later.
let mergeInFlight = false;

/**
 * After login, moves the guest cart into the server cart once (D4, §10): `POST /me/cart/merge`,
 * then clears `localStorage` and reports what was skipped. A network or 5xx failure keeps the
 * guest cart for the next page load; a 4xx (nothing to retry) clears it and says so.
 */
export function useGuestCartMerge(signedIn: boolean) {
  const queryClient = useQueryClient();
  const { ids } = useGuestCart();
  const [notice, setNotice] = useState<MergeNotice | null>(null);

  useEffect(() => {
    if (!signedIn || ids.length === 0 || mergeInFlight) return;
    mergeInFlight = true;
    const titles = new Map(ids.map((id) => [id, guestCartLabel(id)?.title ?? null]));
    mergeGuestCart(ids)
      .then((result) => {
        queryClient.setQueryData(commerceKeys.cart, result.quote);
        void queryClient.invalidateQueries({ queryKey: commerceKeys.purchaseStatesAll });
        clearGuestCart();
        if (result.skipped.length > 0) {
          setNotice({
            skipped: result.skipped.map((skip) => ({
              ...skip,
              title: titles.get(skip.courseId) ?? null,
            })),
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (
          isApiError(error) &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 401
        ) {
          clearGuestCart();
          void queryClient.invalidateQueries({ queryKey: commerceKeys.cart });
          setNotice({
            skipped: [],
            error: hasCode(error, ErrorCode.CartFull)
              ? 'Your cart is full, so the courses you picked before logging in were not added.'
              : 'The courses you picked before logging in could not be added to your cart.',
          });
        }
      })
      .finally(() => {
        mergeInFlight = false;
      });
  }, [signedIn, ids, queryClient]);

  const dismiss = useCallback(() => setNotice(null), []);
  return { notice, dismiss };
}
