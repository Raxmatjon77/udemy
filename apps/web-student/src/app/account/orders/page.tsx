import type { Metadata } from 'next';

import { OrdersList } from '@/components/commerce/orders';

export const metadata: Metadata = { title: 'Orders & receipts' };

export default function OrdersPage() {
  return (
    <section aria-labelledby="orders-title" className="grid gap-6">
      <div className="grid gap-1">
        <h1 id="orders-title" className="text-2xl font-semibold tracking-tight">
          Orders & receipts
        </h1>
        <p className="text-sm text-muted-foreground">Your purchases, their receipts and refunds.</p>
      </div>
      <OrdersList />
    </section>
  );
}
