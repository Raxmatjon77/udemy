'use client';

import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import Link from 'next/link';

import { useCartCount, useGuestCartMerge, type MergeNotice } from '@/lib/commerce/hooks';
import { CART_PATH } from '@/lib/commerce/links';
import { PURCHASE_BLOCK_SHORT } from '@/lib/commerce/messages';

/**
 * The header cart (design §10 "Header"): a link to `/cart` with the item count (the server cart
 * when signed in, else the guest cart). For a signed-in user it also runs the one-time guest
 * cart merge after login and reports what could not be added.
 */
export function HeaderCart({ signedIn }: { signedIn: boolean }) {
  const count = useCartCount(signedIn);
  const { notice, dismiss } = useGuestCartMerge(signedIn);
  const label =
    count === null || count === 0 ? 'Cart' : `Cart, ${count} ${count === 1 ? 'item' : 'items'}`;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="relative">
        <Link href={CART_PATH} aria-label={label}>
          <CartIcon />
          {count !== null && count > 0 ? (
            <span
              data-testid="cart-count"
              aria-hidden="true"
              className="absolute -top-1 -right-1 flex min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[0.6875rem] leading-5 font-semibold text-primary-foreground tabular-nums"
            >
              {count}
            </span>
          ) : null}
        </Link>
      </Button>
      {notice ? <MergeNoticeToast notice={notice} onDismiss={dismiss} /> : null}
    </>
  );
}

/** "2 items couldn't be added: …" after the guest cart was merged at login. */
export function mergeNoticeText(notice: MergeNotice): string {
  if (notice.error) return notice.error;
  const count = notice.skipped.length;
  const items = notice.skipped
    .map((skip) => `${skip.title ?? 'A course'} (${PURCHASE_BLOCK_SHORT[skip.reason]})`)
    .join(', ');
  return `${count} ${count === 1 ? 'item' : 'items'} couldn't be added to your cart: ${items}.`;
}

function MergeNoticeToast({ notice, onDismiss }: { notice: MergeNotice; onDismiss: () => void }) {
  return (
    <div className="fixed right-4 bottom-4 z-50 w-[min(24rem,calc(100vw-2rem))]">
      <Alert variant="warning" role="status" className="shadow-lg">
        <AlertTitle>Your cart was updated</AlertTitle>
        <AlertDescription>
          <p data-testid="merge-notice">{mergeNoticeText(notice)}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onDismiss}>
            Dismiss
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

function CartIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
      aria-hidden="true"
    >
      <circle cx="8" cy="21" r="1" />
      <circle cx="19" cy="21" r="1" />
      <path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" />
    </svg>
  );
}
