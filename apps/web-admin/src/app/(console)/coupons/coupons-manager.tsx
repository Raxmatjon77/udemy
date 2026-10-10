'use client';

import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { CouponPageSchema, CouponSchema, type Coupon } from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Card, CardContent } from '@udemy/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { LoadMore } from '@/components/load-more';
import { QueryError } from '@/components/query-error';
import { TableSkeleton } from '@/components/table-skeleton';
import { api, queryString } from '@/lib/api';
import { COUPON_STATE_BADGE, COUPON_STATE_LABEL, money } from '@/lib/commerce';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/queries';

import { CouponFormDialog } from './coupon-form-dialog';

const PAGE_SIZE = 20;

function discountOf(coupon: Coupon): string {
  if (coupon.discountType === 'PERCENT') return `${coupon.percentOff ?? 0}% off`;
  return coupon.amountOff && coupon.currency
    ? `${money(coupon.amountOff, coupon.currency)} off`
    : 'Amount off';
}

function usageOf(coupon: Coupon): string {
  const used = coupon.redemptions.consumed + coupon.redemptions.reserved;
  return coupon.maxRedemptions === null
    ? `${used} / unlimited`
    : `${used} / ${coupon.maxRedemptions}`;
}

export function CouponsManager() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState('');
  const coupons = useInfiniteQuery({
    queryKey: queryKeys.coupons,
    queryFn: ({ pageParam }) =>
      api(`/admin/coupons${queryString({ cursor: pageParam, limit: PAGE_SIZE })}`, {
        schema: CouponPageSchema,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.coupons });

  async function deactivate(coupon: Coupon) {
    await api(`/admin/coupons/${encodeURIComponent(coupon.id)}/deactivate`, {
      method: 'POST',
      schema: CouponSchema,
    });
    setNotice(`Deactivated ${coupon.code}.`);
    await refresh();
  }

  let body;
  if (coupons.isPending) {
    body = <TableSkeleton label="Loading coupons" />;
  } else if (!coupons.data) {
    body = <QueryError error={coupons.error} onRetry={() => void coupons.refetch()} />;
  } else {
    const items = coupons.data.pages.flatMap((page) => page.items);
    body =
      items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No platform coupons yet.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="py-2">
            <CardContent className="px-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Discount</TableHead>
                    <TableHead>Valid</TableHead>
                    <TableHead>Used</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((coupon) => (
                    <TableRow key={coupon.id}>
                      <TableCell>
                        <code className="font-mono font-medium">{coupon.code}</code>
                      </TableCell>
                      <TableCell>{discountOf(coupon)}</TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        <time dateTime={coupon.startsAt}>{formatDateTime(coupon.startsAt)}</time>
                        {' – '}
                        <time dateTime={coupon.endsAt}>{formatDateTime(coupon.endsAt)}</time>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {usageOf(coupon)}
                        {coupon.redemptions.reserved > 0 ? (
                          <div className="text-xs text-muted-foreground">
                            {coupon.redemptions.reserved} reserved in open checkouts
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant={COUPON_STATE_BADGE[coupon.state]}>
                          {COUPON_STATE_LABEL[coupon.state]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {coupon.state === 'DEACTIVATED' || coupon.state === 'EXPIRED' ? null : (
                          <ConfirmDialog
                            trigger={
                              <Button
                                size="sm"
                                variant="outline"
                                aria-label={`Deactivate ${coupon.code}`}
                              >
                                Deactivate
                              </Button>
                            }
                            title={`Deactivate ${coupon.code}?`}
                            description="Students can no longer apply it. Checkouts already open keep their reservation. This cannot be undone."
                            confirmLabel="Deactivate"
                            pendingLabel="Deactivating…"
                            destructive
                            onConfirm={() => deactivate(coupon)}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <LoadMore query={coupons} count={items.length} noun={['coupon', 'coupons']} />
        </>
      );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {notice}
        </p>
        <CouponFormDialog
          trigger={<Button>New coupon</Button>}
          onCreated={(coupon) => {
            setNotice(`Created ${coupon.code}.`);
            void refresh();
          }}
        />
      </div>
      {body}
    </div>
  );
}
