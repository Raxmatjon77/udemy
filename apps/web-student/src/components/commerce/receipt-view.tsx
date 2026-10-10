'use client';

import { useQuery } from '@tanstack/react-query';
import { ErrorCode } from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Skeleton } from '@udemy/ui/components/skeleton';
import Link from 'next/link';

import { commerceKeys, fetchReceipt } from '@/lib/commerce/client';
import { discount, money } from '@/lib/commerce/format';
import { orderHref } from '@/lib/commerce/links';
import { formatDate } from '@/lib/format';
import { problemMessage } from '@/lib/problem';

/**
 * `/account/orders/[id]/receipt`: a printable receipt (`print:` styles hide everything else).
 * No card details exist to show (§9 PCI: not even the last four digits are stored).
 */
export function ReceiptView({ orderId }: { orderId: string }) {
  const receipt = useQuery({
    queryKey: commerceKeys.receipt(orderId),
    queryFn: ({ signal }) => fetchReceipt(orderId, signal),
  });

  if (receipt.isPending) return <Skeleton className="h-80 w-full" />;
  if (receipt.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          <p>
            {problemMessage(receipt.error, {
              [ErrorCode.OrderNotPaid]: 'This order is not paid, so there is no receipt yet.',
              [ErrorCode.OrderNotFound]: 'We could not find this order.',
            })}
          </p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href={orderHref(orderId)}>Back to the order</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const data = receipt.data;
  return (
    <article
      data-testid="receipt"
      aria-labelledby="receipt-title"
      className="flex flex-col gap-6 rounded-lg border bg-card p-6 print:border-0 print:p-0"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 id="receipt-title" className="text-2xl font-semibold tracking-tight">
            Receipt
          </h1>
          <p className="text-sm text-muted-foreground">Udemy</p>
        </div>
        <dl className="grid gap-0.5 text-right text-sm">
          <div>
            <dt className="inline text-muted-foreground">Order </dt>
            <dd className="inline font-medium">#{data.orderNumber}</dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Date </dt>
            <dd className="inline">
              <time dateTime={data.issuedAt}>{formatDate(data.issuedAt)}</time>
            </dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Billed to </dt>
            <dd className="inline">{data.buyer.displayName}</dd>
          </div>
        </dl>
      </header>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 font-medium">Course</th>
            <th className="py-2 text-right font-medium">Price</th>
            <th className="py-2 text-right font-medium">Discount</th>
            <th className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((line, index) => (
            <tr key={index} className="border-b">
              <td className="py-2">
                {line.courseTitle}
                {line.couponCode ? (
                  <span className="block text-xs text-muted-foreground">
                    Code {line.couponCode}
                  </span>
                ) : null}
              </td>
              <td className="py-2 text-right tabular-nums">
                {money(line.listAmount, data.currency)}
              </td>
              <td className="py-2 text-right tabular-nums">
                {discount(line.discountAmount, data.currency)}
              </td>
              <td className="py-2 text-right tabular-nums">
                {money(line.finalAmount, data.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="ml-auto grid w-full max-w-xs gap-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="tabular-nums">{money(data.subtotalAmount, data.currency)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Discounts</dt>
          <dd className="tabular-nums">{discount(data.discountAmount, data.currency)}</dd>
        </div>
        <div className="flex justify-between border-t pt-2 font-semibold">
          <dt>Total paid</dt>
          <dd data-testid="receipt-total" className="tabular-nums">
            {money(data.totalAmount, data.currency)}
          </dd>
        </div>
        {data.refundedAmount !== '0.00' ? (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Refunded</dt>
            <dd className="tabular-nums">{money(data.refundedAmount, data.currency)}</dd>
          </div>
        ) : null}
      </dl>

      <p className="text-xs text-muted-foreground">
        {data.paymentProvider === 'NONE'
          ? 'No payment was needed for this order (fully discounted).'
          : 'Paid by card. Prices include any applicable taxes.'}
      </p>

      <div className="flex flex-wrap gap-2 print:hidden">
        <Button onClick={() => window.print()}>Print receipt</Button>
        <Button asChild variant="outline">
          <Link href={orderHref(orderId)}>Back to the order</Link>
        </Button>
      </div>
    </article>
  );
}
