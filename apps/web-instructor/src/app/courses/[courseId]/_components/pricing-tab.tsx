'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import {
  CurrencySchema,
  DEFAULT_CURRENCY,
  ErrorCode,
  isFreeAmount,
  isPriceTier,
  PRICE_CHANGES_PER_DAY,
  PRICE_TIERS,
  PriceTierSchema,
  type CoursePricing,
  type PriceTier,
} from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { FormField } from '@udemy/ui/components/form-field';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { Skeleton } from '@udemy/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { FormAlert } from '@/components/form-alert';
import { QueryError } from '@/components/query-error';
import { SubmitButton } from '@/components/submit-button';
import { commerceApi } from '@/lib/commerce-api';
import { commerceKeys, useCoursePricing } from '@/lib/commerce-queries';
import { applyServerError, ROOT_SERVER } from '@/lib/form';
import { formatDateTime } from '@/lib/format';
import { estimateInstructorShare, INSTRUCTOR_SHARE_PERCENT, priceLabel } from '@/lib/money';
import { formatWait, isApiError } from '@/lib/problem';
import { formResolver } from '@/lib/zod-messages';

const TIERS = PRICE_TIERS[DEFAULT_CURRENCY];

/** The tier select; `PriceTierSchema` (contracts) is the authority on allowed amounts. */
const PriceFormSchema = z
  .object({ amount: z.string().min(1, 'Choose a price tier.'), currency: CurrencySchema })
  .pipe(PriceTierSchema);

/** The 429 of `PUT /pricing` (10 changes per course per 24 h), with the `Retry-After` wait. */
export function priceRateLimitMessage(retryAfterSeconds: number | null): string {
  const base = `You can change the price at most ${PRICE_CHANGES_PER_DAY} times a day.`;
  return retryAfterSeconds === null
    ? `${base} Please try again later.`
    : `${base} Try again ${formatWait(retryAfterSeconds)}.`;
}

function toFormValues(pricing: CoursePricing | undefined): PriceTier {
  return { amount: pricing?.price?.amount ?? '', currency: DEFAULT_CURRENCY };
}

/** "You earn about $X per sale" for a tier (an estimate: the api computes the real share). */
function ShareEstimate({ amount }: { amount: string }) {
  if (!isPriceTier(amount, DEFAULT_CURRENCY)) return null;
  if (isFreeAmount(amount)) {
    return (
      <p className="text-sm text-muted-foreground">
        Students enroll for free, so this course earns no revenue.
      </p>
    );
  }
  return (
    <p className="text-sm">
      You earn about <strong>{priceLabel(estimateInstructorShare(amount))}</strong> per sale.{' '}
      <span className="text-muted-foreground">
        Estimate: {INSTRUCTOR_SHARE_PERCENT}% of what the student pays; coupons lower it.
      </span>
    </p>
  );
}

/**
 * Pricing tab (Phase 4 design D2, §10): a tier select (Free plus the `PRICE_TIERS`), the share
 * estimate and the append-only price history. A price applies immediately, also while the
 * course is a draft or in review, so this tab is never read-only.
 */
export function PricingTab({ courseId }: { courseId: string }) {
  const queryClient = useQueryClient();
  const pricing = useCoursePricing(courseId);
  const [saved, setSaved] = useState<string | null>(null);

  const form = useForm({
    resolver: formResolver(PriceFormSchema),
    defaultValues: toFormValues(pricing.data),
  });
  const { register, handleSubmit, formState, setError, reset, control } = form;
  const selected = useWatch({ control, name: 'amount' });

  // The first load (or a refetch) resets the select to the stored price.
  const storedAmount = pricing.data?.price?.amount ?? '';
  useEffect(() => {
    if (pricing.data) reset(toFormValues(pricing.data));
  }, [pricing.data, reset]);

  const save = useMutation({
    mutationFn: (amount: string) => commerceApi.setPrice(courseId, amount),
    onSuccess: (updated) => {
      queryClient.setQueryData(commerceKeys.pricing(courseId), updated);
      const amount = updated.price?.amount;
      setSaved(
        amount === undefined
          ? 'Price saved.'
          : `Price saved: ${priceLabel(amount)}. It applies to new purchases now.`,
      );
    },
    onError: (error) => {
      setSaved(null);
      if (isApiError(error) && error.status === 429) {
        setError(ROOT_SERVER, {
          type: 'server',
          message: priceRateLimitMessage(error.retryAfterSeconds),
        });
        return;
      }
      applyServerError(setError, error, {
        fields: ['amount'],
        codeFields: { [ErrorCode.PriceNotAllowed]: 'amount' },
        messages: {
          [ErrorCode.PriceNotAllowed]: 'This price is not one of the allowed price tiers.',
        },
      });
    },
  });

  if (pricing.isPending) return <Skeleton className="h-64 w-full" />;
  if (pricing.isError) {
    return <QueryError error={pricing.error} onRetry={() => void pricing.refetch()} />;
  }

  const data = pricing.data;
  const errors = formState.errors;
  const unchanged = selected === storedAmount;

  return (
    <div className="grid gap-10">
      <section aria-labelledby="pricing-heading" className="grid gap-6">
        <div className="grid gap-1">
          <h2 id="pricing-heading" className="text-xl font-semibold">
            Pricing
          </h2>
          <p className="text-sm text-muted-foreground">
            A new price applies immediately to new purchases, also while the course is a draft or in
            review. Checkouts already in progress keep their price. You can change the price up to{' '}
            {PRICE_CHANGES_PER_DAY} times a day.
          </p>
        </div>

        {data.price === null ? (
          <Alert>
            <AlertTitle>No price yet</AlertTitle>
            <AlertDescription>
              Students cannot buy or enroll in this course until you choose a price (or Free).
            </AlertDescription>
          </Alert>
        ) : (
          <p>
            Current price: <strong>{priceLabel(data.price.amount, data.price.currency)}</strong>
          </p>
        )}

        <form
          noValidate
          onSubmit={handleSubmit((values) => {
            setSaved(null);
            save.mutate(values.amount);
          })}
          className="grid max-w-md gap-4"
          aria-label="Set the course price"
        >
          <FormAlert message={errors.root?.server?.message} />
          <FormField id="course-price" label="Price tier" error={errors.amount?.message}>
            {(field) => (
              <NativeSelect {...field} {...register('amount')}>
                {data.price === null ? <option value="">Choose a price</option> : null}
                {TIERS.map((amount) => (
                  <option key={amount} value={amount}>
                    {priceLabel(amount)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <div aria-live="polite">
            <ShareEstimate amount={selected} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton pending={save.isPending} pendingLabel="Saving…" disabled={unchanged}>
              Save price
            </SubmitButton>
            <p role="status" className="text-sm text-muted-foreground">
              {saved}
            </p>
          </div>
        </form>
      </section>

      <section aria-labelledby="price-history-heading" className="grid gap-3">
        <h3 id="price-history-heading" className="text-lg font-semibold">
          Price history
        </h3>
        {data.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No price changes yet.</p>
        ) : (
          <Table>
            <TableCaption className="sr-only">Price changes, newest first</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Changed</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.history.map((change) => (
                <TableRow key={change.id}>
                  <TableCell className="text-muted-foreground">
                    <time dateTime={change.changedAt}>{formatDateTime(change.changedAt)}</time>
                  </TableCell>
                  <TableCell>
                    {change.previousAmount === null
                      ? 'No price'
                      : priceLabel(change.previousAmount, change.currency)}
                  </TableCell>
                  <TableCell>{priceLabel(change.amount, change.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
