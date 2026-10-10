import { UuidSchema } from '@udemy/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { OrderDetailView } from '@/components/commerce/orders';
import { checkoutAllowedOrigins } from '@/lib/env';

export const metadata: Metadata = { title: 'Order details' };

/** `/account/orders/[id]` (session required; a foreign order is a 404 from the API). */
export default async function OrderPage({ params }: PageProps<'/account/orders/[id]'>) {
  const { id } = await params;
  if (!UuidSchema.safeParse(id).success) notFound();
  return <OrderDetailView orderId={id} allowedOrigins={[...checkoutAllowedOrigins()]} />;
}
