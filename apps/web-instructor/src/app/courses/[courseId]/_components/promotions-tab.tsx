'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm, useWatch } from 'react-hook-form';
import {
  COUPON_LIMITS,
  ErrorCode,
  isFreeAmount,
  type Coupon,
  type CouponState,
  type CreateCourseCouponRequest,
} from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@udemy/ui/components/dialog';
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

import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormAlert } from '@/components/form-alert';
import { QueryError } from '@/components/query-error';
import { SubmitButton } from '@/components/submit-button';
import { commerceApi } from '@/lib/commerce-api';
import { commerceKeys, useCourseCoupons, useCoursePricing } from '@/lib/commerce-queries';
import { applyServerError, ROOT_SERVER } from '@/lib/form';
import { formatDateTime } from '@/lib/format';
import { money } from '@/lib/money';
import { formatWait, isApiError } from '@/lib/problem';
import { formResolver } from '@/lib/zod-messages';

import {
  COUPON_FORM_FIELDS,
  couponFormSchema,
  defaultCouponValues,
  previewPrice,
} from './coupon-form';

const STATE_LABELS: Record<CouponState, string> = {
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  EXHAUSTED: 'Used up',
  EXPIRED: 'Expired',
  DEACTIVATED: 'Deactivated',
};

/** States that count towards the 10-active limit (D5) and that can still be deactivated. */
const LIVE_STATES: ReadonlySet<CouponState> = new Set(['SCHEDULED', 'ACTIVE', 'EXHAUSTED']);

function discountLabel(coupon: Coupon): string {
  if (coupon.discountType === 'PERCENT') return `${coupon.percentOff ?? 0}% off`;
  return `${money(coupon.amountOff ?? '0.00', coupon.currency ?? undefined)} off`;
}

function usageLabel(coupon: Coupon): string {
  const { consumed, reserved } = coupon.redemptions;
  const max = coupon.maxRedemptions === null ? 'unlimited' : String(coupon.maxRedemptions);
  return `${consumed} / ${max}${reserved > 0 ? ` (${reserved} in checkout)` : ''}`;
}

/**
 * Promotions tab (Phase 4 design D5, §10): the course's coupons (active and inactive, newest
 * first) with their redemption counts, a create dialog and deactivate. Coupons are immutable
 * after creation, so there is no edit.
 *
 * No share link: neither the design nor the contracts define a coupon prefill on the landing
 * page (`?coupon=`), so students type the code in the cart.
 */
export function PromotionsTab({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const pricing = useCoursePricing(courseId);
  const coupons = useCourseCoupons(courseId);

  const deactivate = useMutation({
    mutationFn: (couponId: string) => commerceApi.deactivateCoupon(courseId, couponId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: commerceKeys.coupons(courseId) }),
  });

  if (pricing.isPending || coupons.isPending) return <Skeleton className="h-64 w-full" />;
  if (pricing.isError) {
    return <QueryError error={pricing.error} onRetry={() => void pricing.refetch()} />;
  }
  if (coupons.isError && !coupons.data) {
    return <QueryError error={coupons.error} onRetry={() => void coupons.refetch()} />;
  }

  const price = pricing.data.price;
  const rows = coupons.data?.pages.flatMap((page) => page.items) ?? [];
  const liveCount = rows.filter((coupon) => LIVE_STATES.has(coupon.state)).length;
  const atLimit = liveCount >= COUPON_LIMITS.maxActivePerCourse;

  return (
    <section aria-labelledby="promotions-heading" className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h2 id="promotions-heading" className="text-xl font-semibold">
            Promotions
          </h2>
          <p className="text-sm text-muted-foreground">
            Coupons for this course. Each student can use a coupon once. A coupon cannot be changed
            after it is created, only deactivated. At most {COUPON_LIMITS.maxActivePerCourse}{' '}
            coupons can be active at a time.
          </p>
        </div>
        {price !== null && !isFreeAmount(price.amount) ? (
          <CreateCouponDialog courseId={courseId} listAmount={price.amount} disabled={atLimit} />
        ) : null}
      </div>

      {price === null ? (
        <Alert>
          <AlertTitle>Set a price first</AlertTitle>
          <AlertDescription>
            Coupons need a paid price. Choose one in the Pricing tab.
          </AlertDescription>
        </Alert>
      ) : isFreeAmount(price.amount) ? (
        <Alert>
          <AlertTitle>This course is free</AlertTitle>
          <AlertDescription>Coupons are only for paid courses.</AlertDescription>
        </Alert>
      ) : atLimit ? (
        <p className="text-sm text-muted-foreground">
          This course has {COUPON_LIMITS.maxActivePerCourse} active coupons. Deactivate one to
          create another.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
          No coupons yet.
        </p>
      ) : (
        <Table>
          <TableCaption className="sr-only">Coupons, newest first</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Discount</TableHead>
              <TableHead>Valid</TableHead>
              <TableHead>Redeemed</TableHead>
              <TableHead>State</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((coupon) => (
              <TableRow key={coupon.id} data-coupon-code={coupon.code}>
                <TableCell className="font-mono font-medium">{coupon.code}</TableCell>
                <TableCell>{discountLabel(coupon)}</TableCell>
                <TableCell className="text-muted-foreground">
                  <time dateTime={coupon.startsAt}>{formatDateTime(coupon.startsAt)}</time> –{' '}
                  <time dateTime={coupon.endsAt}>{formatDateTime(coupon.endsAt)}</time>
                </TableCell>
                <TableCell>{usageLabel(coupon)}</TableCell>
                <TableCell>
                  <Badge variant={coupon.state === 'ACTIVE' ? 'default' : 'outline'}>
                    {STATE_LABELS[coupon.state]}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {LIVE_STATES.has(coupon.state) ? (
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
                      title={`Deactivate coupon ${coupon.code}?`}
                      description="Students can no longer use this code. Checkouts already in progress keep their discount. This cannot be undone."
                      confirmLabel="Deactivate"
                      pendingLabel="Deactivating…"
                      onConfirm={() => deactivate.mutateAsync(coupon.id)}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {coupons.isFetchNextPageError ? (
        <QueryError error={coupons.error} onRetry={() => void coupons.fetchNextPage()} />
      ) : null}
      {coupons.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            onClick={() => void coupons.fetchNextPage()}
            disabled={coupons.isFetchingNextPage}
          >
            {coupons.isFetchingNextPage ? (
              <>
                <Spinner /> Loading…
              </>
            ) : (
              'Load more'
            )}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function CreateCouponDialog({
  courseId,
  listAmount,
  disabled,
}: {
  courseId: string;
  listAmount: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={disabled}>Create coupon</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create coupon</DialogTitle>
          <DialogDescription>
            List price {money(listAmount)}. The terms cannot be changed later.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <CreateCouponForm
            courseId={courseId}
            listAmount={listAmount}
            onCreated={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateCouponForm({
  courseId,
  listAmount,
  onCreated,
}: {
  courseId: string;
  listAmount: string;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const schema = useMemo(() => couponFormSchema(listAmount), [listAmount]);
  const form = useForm({
    resolver: formResolver(schema),
    defaultValues: defaultCouponValues(new Date()),
  });
  const { register, handleSubmit, formState, setError, control } = form;
  const [discountType, percentOff, amountOff] = useWatch({
    control,
    name: ['discountType', 'percentOff', 'amountOff'],
  });
  const preview = previewPrice(listAmount, { discountType, percentOff, amountOff });

  const create = useMutation({
    mutationFn: (body: CreateCourseCouponRequest) => commerceApi.createCoupon(courseId, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: commerceKeys.coupons(courseId) });
      onCreated();
    },
    onError: (error) => {
      if (isApiError(error) && error.status === 429) {
        const wait = error.retryAfterSeconds;
        setError(ROOT_SERVER, {
          type: 'server',
          message: `You can create at most ${COUPON_LIMITS.creationsPerDay} coupons a day. ${
            wait === null ? 'Please try again later.' : `Try again ${formatWait(wait)}.`
          }`,
        });
        return;
      }
      applyServerError(setError, error, {
        fields: COUPON_FORM_FIELDS,
        codeFields: { [ErrorCode.CouponCodeTaken]: 'code' },
        messages: {
          [ErrorCode.CouponCodeTaken]: 'This course already has a coupon with this code.',
          [ErrorCode.CouponLimitExceeded]: `A course can have at most ${COUPON_LIMITS.maxActivePerCourse} active coupons. Deactivate one first.`,
          [ErrorCode.CourseIsFree]: 'Free courses cannot have coupons.',
        },
      });
    },
  });

  const errors = formState.errors;
  return (
    <form
      noValidate
      onSubmit={handleSubmit((body) => create.mutate(body))}
      className="grid gap-4"
      aria-label="Create coupon"
    >
      <FormAlert message={errors.root?.server?.message} />
      <Controller
        control={control}
        name="code"
        render={({ field, fieldState }) => (
          <FormField
            id="coupon-code"
            label="Code"
            description='4–20 letters, digits, "_" or "-". Letters are uppercased.'
            error={fieldState.error?.message}
          >
            {(aria) => (
              <Input
                {...aria}
                ref={field.ref}
                name={field.name}
                value={field.value}
                onBlur={field.onBlur}
                onChange={(event) => field.onChange(event.target.value.toUpperCase())}
                autoComplete="off"
                spellCheck={false}
                maxLength={20}
                className="font-mono uppercase"
              />
            )}
          </FormField>
        )}
      />

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Discount type</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" value="PERCENT" {...register('discountType')} />
          Percent off
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" value="AMOUNT" {...register('discountType')} />
          Amount off (USD)
        </label>
      </fieldset>

      {discountType === 'PERCENT' ? (
        <FormField
          id="coupon-percentOff"
          label="Percent off"
          description={`${COUPON_LIMITS.minPercentOff}–${COUPON_LIMITS.maxPercentOff}.`}
          error={errors.percentOff?.message}
        >
          {(aria) => <Input {...aria} inputMode="numeric" {...register('percentOff')} />}
        </FormField>
      ) : (
        <FormField
          id="coupon-amountOff"
          label="Amount off"
          description={`In USD, at most the list price (${money(listAmount)}).`}
          error={errors.amountOff?.message}
        >
          {(aria) => <Input {...aria} inputMode="decimal" {...register('amountOff')} />}
        </FormField>
      )}

      <p aria-live="polite" className="text-sm">
        {preview === null ? null : (
          <>
            Students pay <strong>{money(preview)}</strong> instead of {money(listAmount)}.
          </>
        )}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="coupon-startsAt"
          label="Starts"
          hint="Optional"
          description="Empty: starts now."
          error={errors.startsAt?.message}
        >
          {(aria) => <Input {...aria} type="datetime-local" {...register('startsAt')} />}
        </FormField>
        <FormField
          id="coupon-endsAt"
          label="Ends"
          description={`The coupon runs ${COUPON_LIMITS.courseWindowMinDays}–${COUPON_LIMITS.courseWindowMaxDays} days.`}
          error={errors.endsAt?.message}
        >
          {(aria) => <Input {...aria} type="datetime-local" {...register('endsAt')} />}
        </FormField>
      </div>

      <FormField
        id="coupon-maxRedemptions"
        label="Maximum redemptions"
        hint="Optional"
        description="Empty: unlimited."
        error={errors.maxRedemptions?.message}
      >
        {(aria) => <Input {...aria} inputMode="numeric" {...register('maxRedemptions')} />}
      </FormField>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <SubmitButton pending={create.isPending} pendingLabel="Creating…">
          Create coupon
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}
