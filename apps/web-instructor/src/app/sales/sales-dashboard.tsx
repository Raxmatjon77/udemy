'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  SALES_SUMMARY_MAX_RANGE_DAYS,
  type SalesSummaryQuery,
  type SalesTotals,
} from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { QueryError } from '@/components/query-error';
import { useRecentSales, useSalesSummary } from '@/lib/commerce-queries';
import { formatDate, formatDateTime } from '@/lib/format';
import { money } from '@/lib/money';
import { formResolver } from '@/lib/zod-messages';

import { lastDays, rangeDays, SalesRangeFormSchema, toSalesQuery } from './sales-range';

const DEFAULT_RANGE_DAYS = 30;

/**
 * `/sales` (Phase 4 design §10): a date range, summary cards (gross, refunds, net, your share),
 * a per-course table and the recent sales (keyset "Load more"). No buyer PII anywhere.
 */
export function SalesDashboard() {
  const [range, setRange] = useState<SalesSummaryQuery>(() =>
    toSalesQuery(lastDays(DEFAULT_RANGE_DAYS, new Date())),
  );

  return (
    <div className="grid gap-10">
      <div className="grid gap-1">
        <h1 className="text-3xl font-bold tracking-tight">Sales</h1>
        <p className="text-muted-foreground">
          Revenue from your courses. Amounts are in USD; your share is what you earn after the
          platform fee.
        </p>
      </div>
      <RangeForm onApply={setRange} />
      <Summary range={range} />
      <RecentSales />
    </div>
  );
}

function RangeForm({ onApply }: { onApply: (range: SalesSummaryQuery) => void }) {
  const form = useForm({
    resolver: formResolver(SalesRangeFormSchema),
    defaultValues: lastDays(DEFAULT_RANGE_DAYS, new Date()),
  });
  const { register, handleSubmit, formState } = form;
  const errors = formState.errors;
  return (
    <form
      noValidate
      onSubmit={handleSubmit(onApply)}
      aria-label="Date range"
      className="flex flex-wrap items-start gap-4"
    >
      <FormField id="sales-from" label="From" error={errors.from?.message} className="w-44">
        {(aria) => <Input {...aria} type="date" {...register('from')} />}
      </FormField>
      <FormField
        id="sales-to"
        label="To"
        error={errors.to?.message}
        description={`Up to ${SALES_SUMMARY_MAX_RANGE_DAYS} days.`}
        className="w-44"
      >
        {(aria) => <Input {...aria} type="date" {...register('to')} />}
      </FormField>
      <Button type="submit" variant="outline" className="mt-[22px]">
        Show
      </Button>
    </form>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="grid gap-1 rounded-xl border p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

function Totals({ totals, currency }: { totals: SalesTotals; currency: 'USD' }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <Stat label="Sales" value={String(totals.salesCount)} />
      <Stat
        label="Gross"
        value={money(totals.gross, currency)}
        note={`${money(totals.discounts, currency)} in coupon discounts`}
      />
      <Stat
        label="Refunds"
        value={money(totals.refunded, currency)}
        note={`${totals.refundCount} refunded ${totals.refundCount === 1 ? 'sale' : 'sales'}`}
      />
      <Stat label="Net" value={money(totals.net, currency)} note="Gross − discounts − refunds" />
      <Stat label="Your share" value={money(totals.instructorShare, currency)} />
    </dl>
  );
}

function Summary({ range }: { range: SalesSummaryQuery }) {
  const summary = useSalesSummary(range);
  const days = rangeDays(range);
  const heading = `${formatDate(`${days.from}T12:00:00`)} – ${formatDate(`${days.to}T12:00:00`)}`;

  return (
    <section aria-labelledby="sales-summary-heading" className="grid gap-6">
      <h2 id="sales-summary-heading" className="text-xl font-semibold">
        Summary <span className="font-normal text-muted-foreground">({heading})</span>
      </h2>
      {summary.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : summary.isError ? (
        <QueryError error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        <>
          <Totals totals={summary.data.totals} currency={summary.data.currency} />
          <div className="grid gap-3">
            <h3 className="text-lg font-semibold">By course</h3>
            {summary.data.courses.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sales in this period.</p>
            ) : (
              <Table>
                <TableCaption className="sr-only">Sales per course, highest net first</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Course</TableHead>
                    <TableHead className="text-right">Sales</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Refunds</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead className="text-right">Your share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.data.courses.map((row) => (
                    <TableRow key={row.courseId}>
                      <TableCell className="max-w-xs truncate font-medium">
                        {row.courseTitle}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.salesCount}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(row.gross, summary.data.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(row.refunded, summary.data.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(row.net, summary.data.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {money(row.instructorShare, summary.data.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function RecentSales() {
  const sales = useRecentSales();
  const rows = sales.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section aria-labelledby="recent-sales-heading" className="grid gap-3">
      <h2 id="recent-sales-heading" className="text-xl font-semibold">
        Recent sales
      </h2>
      {sales.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : sales.isError && rows.length === 0 ? (
        <QueryError error={sales.error} onRetry={() => void sales.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sales yet.</p>
      ) : (
        <>
          <Table>
            <TableCaption className="sr-only">Recent sales, newest first</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Course</TableHead>
                <TableHead>Coupon</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Your share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((sale) => (
                <TableRow key={sale.orderLineId} data-order-line-id={sale.orderLineId}>
                  <TableCell className="text-muted-foreground">
                    <time dateTime={sale.paidAt}>{formatDateTime(sale.paidAt)}</time>
                  </TableCell>
                  <TableCell className="max-w-xs truncate font-medium">
                    {sale.courseTitle}
                  </TableCell>
                  <TableCell className="font-mono">{sale.couponCode ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {sale.finalAmount === sale.listAmount ? null : (
                      <s className="mr-2 text-muted-foreground">
                        {money(sale.listAmount, sale.currency)}
                      </s>
                    )}
                    {money(sale.finalAmount, sale.currency)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {sale.refunded ? (
                      <Badge variant="outline">Refunded</Badge>
                    ) : (
                      money(sale.instructorShareAmount, sale.currency)
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {sales.isFetchNextPageError ? (
            <QueryError error={sales.error} onRetry={() => void sales.fetchNextPage()} />
          ) : null}
          {sales.hasNextPage ? (
            <div>
              <Button
                variant="outline"
                onClick={() => void sales.fetchNextPage()}
                disabled={sales.isFetchingNextPage}
              >
                {sales.isFetchingNextPage ? (
                  <>
                    <Spinner /> Loading…
                  </>
                ) : (
                  'Load more'
                )}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
