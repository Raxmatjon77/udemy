'use client';

import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
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
import { Textarea } from '@udemy/ui/components/textarea';

import { FormAlert } from '@/components/form-alert';
import { SubmitButton } from '@/components/submit-button';
import { applyServerError } from '@/lib/form';
import type { MessageOverrides } from '@/lib/problem';
import { formResolver } from '@/lib/zod-messages';

export type ReasonFormSchema = z.ZodType<{ reason?: string | undefined }, { reason: string }>;

export interface ReasonDialogProps {
  /** The button that opens the dialog. */
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  label: string;
  /** Help text under the textarea, e.g. who will see the reason. */
  fieldDescription?: string;
  /** Validates the textarea: a contracts schema (required reason) or an optional one. */
  schema: ReasonFormSchema;
  optional?: boolean;
  confirmLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  /** `maxLength` of the textarea; match the schema's upper bound (default 1000). */
  maxLength?: number;
  /** Performs the action; a rejection is shown in the dialog, which stays open. */
  onConfirm: (reason: string | undefined) => Promise<unknown>;
  messages?: MessageOverrides;
}

/**
 * A confirmation modal with a reason textarea (reject, approve with a note, ban, unban).
 * Focus moves into the dialog, Escape cancels, and focus returns to the trigger afterwards.
 */
export function ReasonDialog({
  trigger,
  title,
  description,
  label,
  fieldDescription,
  schema,
  optional = false,
  confirmLabel,
  pendingLabel,
  destructive = false,
  maxLength = 1000,
  onConfirm,
  messages,
}: ReasonDialogProps) {
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, formState, setError, reset } = useForm({
    resolver: formResolver(schema),
    defaultValues: { reason: '' },
  });
  const pending = formState.isSubmitting;

  const submit = handleSubmit(async ({ reason }) => {
    try {
      await onConfirm(reason);
      setOpen(false);
      reset();
    } catch (error) {
      applyServerError(setError, error, { fields: ['reason'], ...(messages ? { messages } : {}) });
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form noValidate onSubmit={submit} className="grid gap-4" aria-busy={pending}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FormAlert message={formState.errors.root?.server?.message} />
          <FormField
            id="decision-reason"
            label={label}
            hint={optional ? 'Optional' : undefined}
            description={fieldDescription}
            error={formState.errors.reason?.message}
          >
            {(field) => (
              <Textarea
                {...field}
                rows={5}
                maxLength={maxLength}
                autoFocus
                aria-required={!optional}
                {...register('reason')}
              />
            )}
          </FormField>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton
              pending={pending}
              pendingLabel={pendingLabel}
              variant={destructive ? 'destructive' : 'default'}
            >
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
