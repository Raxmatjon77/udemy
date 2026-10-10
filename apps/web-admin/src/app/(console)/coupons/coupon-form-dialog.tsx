'use client';

import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  COUPON_CODE_PATTERN,
  COUPON_LIMITS,
  CouponSchema,
  CreatePlatformCouponRequestSchema,
  ErrorCode,
  type Coupon,
  type CreatePlatformCouponRequest,
} from '@udemy/contracts';
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

import { FormAlert } from '@/components/form-alert';
import { SubmitButton } from '@/components/submit-button';
import { api } from '@/lib/api';
import { applyServerError } from '@/lib/form';
import { formResolver } from '@/lib/zod-messages';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `datetime-local` value (the admin's local time) → ISO instant, or undefined. */
function localToIso(value: string): string | undefined {
  if (value === '') return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const integer = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((value) => /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max, {
      message: `${label} must be a whole number from ${min} to ${max.toLocaleString('en-US')}.`,
    });

/**
 * The form works on strings (inputs); the submit maps them to `CreatePlatformCouponRequest`
 * and checks that with the contracts schema. Platform coupons are PERCENT only (the contract).
 */
const FormSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(COUPON_CODE_PATTERN, '4–20 letters, digits, "_" or "-".'),
    percentOff: integer('The discount', COUPON_LIMITS.minPercentOff, COUPON_LIMITS.maxPercentOff),
    startsAt: z.string(),
    endsAt: z.string().refine((value) => localToIso(value) !== undefined, 'Choose an end date.'),
    maxRedemptions: z
      .string()
      .trim()
      .refine(
        (value) =>
          value === '' ||
          (/^\d+$/.test(value) &&
            Number(value) >= 1 &&
            Number(value) <= COUPON_LIMITS.maxRedemptions),
        {
          message: `Leave it empty for no limit, or 1 to ${COUPON_LIMITS.maxRedemptions.toLocaleString('en-US')}.`,
        },
      ),
  })
  .superRefine((values, ctx) => {
    const ends = localToIso(values.endsAt);
    if (!ends) return;
    const starts = localToIso(values.startsAt);
    const startMs = starts ? Date.parse(starts) : Date.now();
    const days = (Date.parse(ends) - startMs) / DAY_MS;
    if (days <= 0) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Must be after the start.' });
    } else if (days > COUPON_LIMITS.platformWindowMaxDays) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: `A platform coupon runs for at most ${COUPON_LIMITS.platformWindowMaxDays} days.`,
      });
    }
  });
type FormValues = z.input<typeof FormSchema>;
type Fields = keyof FormValues;
const FIELDS: readonly Fields[] = ['code', 'percentOff', 'startsAt', 'endsAt', 'maxRedemptions'];

const EMPTY: FormValues = {
  code: '',
  percentOff: '',
  startsAt: '',
  endsAt: '',
  maxRedemptions: '',
};

export function CouponFormDialog({
  trigger,
  onCreated,
}: {
  trigger: ReactNode;
  onCreated: (coupon: Coupon) => void;
}) {
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, formState, setError, reset } = useForm({
    resolver: formResolver(FormSchema),
    defaultValues: EMPTY,
  });
  const pending = formState.isSubmitting;

  const submit = handleSubmit(async (values) => {
    const startsAt = localToIso(values.startsAt);
    const endsAt = localToIso(values.endsAt) ?? '';
    const body: CreatePlatformCouponRequest = CreatePlatformCouponRequestSchema.parse({
      code: values.code,
      discountType: 'PERCENT',
      percentOff: Number(values.percentOff),
      endsAt,
      ...(startsAt ? { startsAt } : {}),
      ...(values.maxRedemptions ? { maxRedemptions: Number(values.maxRedemptions) } : {}),
    });
    try {
      const created = await api('/admin/coupons', {
        method: 'POST',
        json: body,
        schema: CouponSchema,
      });
      onCreated(created);
      setOpen(false);
      reset(EMPTY);
    } catch (error) {
      applyServerError(setError, error, {
        fields: FIELDS,
        codeFields: { [ErrorCode.CouponCodeTaken]: 'code' },
      });
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) reset(EMPTY);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form noValidate onSubmit={submit} className="grid gap-4" aria-busy={pending}>
          <DialogHeader>
            <DialogTitle>Create a platform coupon</DialogTitle>
            <DialogDescription>
              A percent discount on every course. Coupons cannot be edited after creation, only
              deactivated. Each student can use a coupon once.
            </DialogDescription>
          </DialogHeader>
          <FormAlert message={formState.errors.root?.server?.message} />
          <FormField
            id="coupon-code"
            label="Code"
            description='4 to 20 letters, digits, "_" or "-"; stored in upper case.'
            error={formState.errors.code?.message}
          >
            {(field) => (
              <Input
                {...field}
                autoComplete="off"
                maxLength={20}
                className="font-mono uppercase"
                {...register('code')}
              />
            )}
          </FormField>
          <FormField
            id="coupon-percent"
            label="Percent off"
            error={formState.errors.percentOff?.message}
          >
            {(field) => (
              <Input {...field} inputMode="numeric" placeholder="20" {...register('percentOff')} />
            )}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="coupon-starts"
              label="Starts"
              hint="Optional"
              description="Empty: now."
              error={formState.errors.startsAt?.message}
            >
              {(field) => <Input {...field} type="datetime-local" {...register('startsAt')} />}
            </FormField>
            <FormField
              id="coupon-ends"
              label="Ends"
              description={`At most ${COUPON_LIMITS.platformWindowMaxDays} days after the start.`}
              error={formState.errors.endsAt?.message}
            >
              {(field) => <Input {...field} type="datetime-local" {...register('endsAt')} />}
            </FormField>
          </div>
          <FormField
            id="coupon-max"
            label="Maximum redemptions"
            hint="Optional"
            description="Empty: unlimited."
            error={formState.errors.maxRedemptions?.message}
          >
            {(field) => <Input {...field} inputMode="numeric" {...register('maxRedemptions')} />}
          </FormField>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton pending={pending} pendingLabel="Creating…">
              Create coupon
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
