import type { Metadata } from 'next';

import { CheckoutSuccess, MissingOrder } from '@/components/commerce/checkout-result';
import { orderIdFromSearch } from '@/lib/commerce/search-params';

export const metadata: Metadata = { title: 'Order confirmation', robots: { index: false } };

/** `/checkout/success?orderId=` (session required): polls the order until it is settled. */
export default async function CheckoutSuccessPage({
  searchParams,
}: PageProps<'/checkout/success'>) {
  const orderId = orderIdFromSearch(await searchParams);
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12 sm:px-6">
      {orderId ? <CheckoutSuccess orderId={orderId} /> : <MissingOrder />}
    </main>
  );
}
