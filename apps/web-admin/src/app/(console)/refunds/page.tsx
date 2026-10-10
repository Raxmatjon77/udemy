import type { Metadata } from 'next';
import { RefundQueueStatusSchema } from '@udemy/contracts';

import { RefundsQueue } from './refunds-queue';

export const metadata: Metadata = { title: 'Refunds' };

export default async function RefundsPage({ searchParams }: PageProps<'/refunds'>) {
  const params = await searchParams;
  const raw = Array.isArray(params.status) ? params.status[0] : params.status;
  const parsed = RefundQueueStatusSchema.safeParse(raw);
  const status = parsed.success ? parsed.data : 'REQUESTED';

  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Refunds</h1>
        <p className="text-sm text-muted-foreground">
          Requests held for review, and refunds the payment provider could not complete. Oldest
          first.
        </p>
      </div>
      <RefundsQueue key={status} status={status} />
    </>
  );
}
