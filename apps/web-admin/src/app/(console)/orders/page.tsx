import type { Metadata } from 'next';
import {
  AdminOrdersQuerySchema,
  OrderNumberSchema,
  OrderStatusSchema,
  UuidSchema,
} from '@udemy/contracts';

import { utcDayStart } from '@/lib/commerce';
import type { OrderFilters } from '@/lib/queries';

import { OrdersSearch } from './orders-search';

export const metadata: Metadata = { title: 'Orders' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function OrdersPage({ searchParams }: PageProps<'/orders'>) {
  const params = await searchParams;
  // Each filter is validated on its own: one bad value does not drop the rest. Dates travel
  // as `YYYY-MM-DD` (UTC days) and become the contract's ISO instants here.
  const q = OrderNumberSchema.safeParse(Number(first(params.q)?.replace(/^#/, '') ?? 'x'));
  const buyerEmail = AdminOrdersQuerySchema.shape.buyerEmail.safeParse(first(params.buyerEmail));
  const status = OrderStatusSchema.safeParse(first(params.status));
  const userId = UuidSchema.safeParse(first(params.userId));
  const courseId = UuidSchema.safeParse(first(params.courseId));
  let from = utcDayStart(first(params.from) ?? '');
  let to = utcDayStart(first(params.to) ?? '', true);
  if (from && to && Date.parse(from) >= Date.parse(to)) {
    from = undefined;
    to = undefined;
  }
  const filters: OrderFilters = {
    q: q.success ? q.data : undefined,
    buyerEmail: buyerEmail.success ? buyerEmail.data : undefined,
    status: status.success ? status.data : undefined,
    userId: userId.success ? userId.data : undefined,
    courseId: courseId.success ? courseId.data : undefined,
    from,
    to,
  };

  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="text-sm text-muted-foreground">
          Search orders by number, buyer (or buyer email), course, status and date, newest first.
        </p>
      </div>
      <OrdersSearch key={JSON.stringify(filters)} filters={filters} />
    </>
  );
}
