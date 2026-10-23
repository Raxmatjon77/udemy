'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  ADMIN_ORDER_BUYER_EMAIL_MIN,
  AdminOrderPageSchema,
  ORDER_STATUSES,
} from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Card, CardContent } from '@udemy/ui/components/card';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';
import { NativeSelect } from '@udemy/ui/components/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { LoadMore } from '@/components/load-more';
import { QueryError } from '@/components/query-error';
import { SearchPicker, type PickerOption } from '@/components/search-picker';
import { TableSkeleton } from '@/components/table-skeleton';
import { api, queryString } from '@/lib/api';
import { money, ORDER_STATUS_BADGE, ORDER_STATUS_LABEL, utcDayOf } from '@/lib/commerce';
import { formatDateTime } from '@/lib/format';
import { searchCourses, searchUsers } from '@/lib/pickers';
import { queryKeys, type OrderFilters } from '@/lib/queries';
import { formResolver } from '@/lib/zod-messages';

const PAGE_SIZE = 20;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The search form; "" means "any". `q` is the order number (a leading `#` is stripped). */
const SearchFormSchema = z
  .object({
    q: z
      .string()
      .trim()
      .transform((value) => value.replace(/^#/, ''))
      .refine((value) => value === '' || /^[1-9]\d{0,15}$/.test(value), {
        message: 'Enter an order number, e.g. 1042.',
      }),
    buyerEmail: z
      .string()
      .trim()
      .refine(
        (value) =>
          value === '' || (value.length >= ADMIN_ORDER_BUYER_EMAIL_MIN && value.length <= 254),
        { message: `Enter at least ${ADMIN_ORDER_BUYER_EMAIL_MIN} characters of the email.` },
      ),
    status: z.enum(['', ...ORDER_STATUSES]),
    from: z.string().refine((value) => value === '' || DATE.test(value), 'Enter a date.'),
    to: z.string().refine((value) => value === '' || DATE.test(value), 'Enter a date.'),
  })
  .refine((v) => v.from === '' || v.to === '' || v.from <= v.to, {
    message: 'The end date must not be before the start date.',
    path: ['to'],
  });

function SearchForm({ filters }: { filters: OrderFilters }) {
  const router = useRouter();
  const [buyer, setBuyer] = useState<PickerOption | null>(
    filters.userId ? { id: filters.userId, label: 'Selected buyer', detail: filters.userId } : null,
  );
  const [course, setCourse] = useState<PickerOption | null>(
    filters.courseId
      ? { id: filters.courseId, label: 'Selected course', detail: filters.courseId }
      : null,
  );
  const defaultValues: z.input<typeof SearchFormSchema> = {
    q: filters.q === undefined ? '' : String(filters.q),
    buyerEmail: filters.buyerEmail ?? '',
    status: filters.status ?? '',
    from: filters.from ? utcDayOf(filters.from) : '',
    to: filters.to ? utcDayOf(filters.to, true) : '',
  };
  const { register, handleSubmit, formState } = useForm({
    resolver: formResolver(SearchFormSchema),
    defaultValues,
  });

  return (
    <form
      role="search"
      aria-label="Search orders"
      noValidate
      onSubmit={handleSubmit((values) =>
        router.push(
          `/orders${queryString({ ...values, userId: buyer?.id, courseId: course?.id })}`,
        ),
      )}
      className="grid gap-4"
    >
      <div className="grid items-start gap-4 sm:grid-cols-[10rem_12rem_1fr_1fr]">
        <FormField id="q" label="Order number" error={formState.errors.q?.message}>
          {(field) => (
            <Input {...field} inputMode="numeric" placeholder="1042" {...register('q')} />
          )}
        </FormField>
        <FormField id="status" label="Status">
          {(field) => (
            <NativeSelect {...field} {...register('status')}>
              <option value="">Any status</option>
              {ORDER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {ORDER_STATUS_LABEL[status]}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <FormField id="from" label="Placed from (UTC)" error={formState.errors.from?.message}>
          {(field) => <Input {...field} type="date" {...register('from')} />}
        </FormField>
        <FormField id="to" label="Placed until (UTC)" error={formState.errors.to?.message}>
          {(field) => <Input {...field} type="date" {...register('to')} />}
        </FormField>
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-3">
        <FormField
          id="buyerEmail"
          label="Buyer email contains"
          description="Part of the email, e.g. jane@ or @example.com."
          error={formState.errors.buyerEmail?.message}
        >
          {(field) => (
            <Input
              {...field}
              type="search"
              autoComplete="off"
              placeholder="jane@"
              {...register('buyerEmail')}
            />
          )}
        </FormField>
        <SearchPicker
          id="buyer"
          label="Buyer"
          placeholder="Name or email"
          value={buyer}
          onChange={setBuyer}
          search={searchUsers}
          queryKey={queryKeys.pickerUsers}
        />
        <SearchPicker
          id="course"
          label="Course"
          placeholder="Course title"
          value={course}
          onChange={setCourse}
          search={searchCourses}
          queryKey={queryKeys.pickerCourses}
        />
      </div>
      <div>
        <Button type="submit">Search</Button>
      </div>
    </form>
  );
}

function Results({ filters }: { filters: OrderFilters }) {
  const orders = useInfiniteQuery({
    queryKey: queryKeys.orderSearch(filters),
    queryFn: ({ pageParam }) =>
      api(`/admin/orders${queryString({ ...filters, cursor: pageParam, limit: PAGE_SIZE })}`, {
        schema: AdminOrderPageSchema,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  if (orders.isPending) return <TableSkeleton label="Loading orders" />;
  if (!orders.data) {
    return <QueryError error={orders.error} onRetry={() => void orders.refetch()} />;
  }

  const items = orders.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No orders match these filters.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      <Card className="py-2">
        <CardContent className="px-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Buyer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Placed</TableHead>
                <TableHead>Paid</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link
                      href={`/orders/${order.id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      #{order.orderNumber}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {order.lineCount} {order.lineCount === 1 ? 'course' : 'courses'}
                    </div>
                  </TableCell>
                  <TableCell>
                    {order.buyer ? (
                      <div className="grid gap-0.5">
                        <span>{order.buyer.displayName}</span>
                        <span className="text-xs text-muted-foreground">{order.buyer.email}</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Deleted account</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={ORDER_STATUS_BADGE[order.status]}>
                      {ORDER_STATUS_LABEL[order.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(order.totalAmount, order.currency)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <time dateTime={order.placedAt}>{formatDateTime(order.placedAt)}</time>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {order.paidAt ? (
                      <time dateTime={order.paidAt}>{formatDateTime(order.paidAt)}</time>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <LoadMore query={orders} count={items.length} noun={['order', 'orders']} />
    </div>
  );
}

export function OrdersSearch({ filters }: { filters: OrderFilters }) {
  return (
    <div className="grid gap-6">
      <SearchForm filters={filters} />
      <Results filters={filters} />
    </div>
  );
}
