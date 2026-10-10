import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { UuidSchema } from '@udemy/contracts';

import { OrderDetailView } from './order-detail';

export const metadata: Metadata = { title: 'Order' };

export default async function OrderPage({ params }: PageProps<'/orders/[id]'>) {
  const { id } = await params;
  if (!UuidSchema.safeParse(id).success) notFound();

  return (
    <>
      <Link
        href="/orders"
        className="w-fit text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← Back to orders
      </Link>
      <OrderDetailView id={id} />
    </>
  );
}
