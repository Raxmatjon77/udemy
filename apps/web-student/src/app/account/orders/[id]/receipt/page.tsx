import { UuidSchema } from '@udemy/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ReceiptView } from '@/components/commerce/receipt-view';

export const metadata: Metadata = { title: 'Receipt' };

/** `/account/orders/[id]/receipt` (session required): printable. */
export default async function ReceiptPage({ params }: PageProps<'/account/orders/[id]/receipt'>) {
  const { id } = await params;
  if (!UuidSchema.safeParse(id).success) notFound();
  return <ReceiptView orderId={id} />;
}
