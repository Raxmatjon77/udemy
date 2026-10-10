import type { Metadata } from 'next';

import { CheckoutCancel, MissingOrder } from '@/components/commerce/checkout-result';
import { orderIdFromSearch } from '@/lib/commerce/search-params';

export const metadata: Metadata = { title: 'Checkout canceled', robots: { index: false } };

/** `/checkout/cancel?orderId=` (session required): the buyer left the hosted payment page. */
export default async function CheckoutCancelPage({ searchParams }: PageProps<'/checkout/cancel'>) {
  const orderId = orderIdFromSearch(await searchParams);
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12 sm:px-6">
      {orderId ? <CheckoutCancel orderId={orderId} /> : <MissingOrder />}
    </main>
  );
}
