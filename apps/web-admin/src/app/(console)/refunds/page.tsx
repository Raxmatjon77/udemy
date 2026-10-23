import type { Metadata } from 'next';
import { ADMIN_REFUND_FILTER_STATUSES } from '@udemy/contracts';
import { z } from 'zod';

import { RefundsQueue } from './refunds-queue';

export const metadata: Metadata = { title: 'Refunds' };

export default async function RefundsPage({ searchParams }: PageProps<'/refunds'>) {
  const params = await searchParams;
  const raw = Array.isArray(params.status) ? params.status[0] : params.status;
  const parsed = z.enum(ADMIN_REFUND_FILTER_STATUSES).safeParse(raw);
  const status = parsed.success ? parsed.data : 'REQUESTED';

  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Refunds</h1>
        <p className="text-sm text-muted-foreground">
          Requests held for review and refunds the payment provider could not complete (the work
          queues), and every other refund by status. Oldest first.
        </p>
      </div>
      <RefundsQueue key={status} status={status} />
    </>
  );
}
