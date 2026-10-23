import type { Metadata } from 'next';

import { CartView } from '@/components/commerce/cart-view';
import { getSession } from '@/lib/auth/session';
import { couponCodeFromSearch } from '@/lib/commerce/search-params';
import { checkoutAllowedOrigins } from '@/lib/env';

export const metadata: Metadata = { title: 'Shopping cart', robots: { index: false } };

/**
 * `/cart` (design §10, public: `PUBLIC_PATHS`): signed-out visitors see their guest cart and
 * log in to check out. The checkout origins come from the server env (not `NEXT_PUBLIC_*`, so
 * one build works in every environment). `?coupon=CODE` prefills the coupon field (a shared
 * promotion link); guests keep it through the login redirect.
 */
export default async function CartPage({ searchParams }: PageProps<'/cart'>) {
  const [session, search] = await Promise.all([getSession(), searchParams]);
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight">Shopping cart</h1>
      <CartView
        signedIn={session !== null}
        allowedOrigins={[...checkoutAllowedOrigins()]}
        couponCode={couponCodeFromSearch(search)}
      />
    </main>
  );
}
