'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
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

import { FormAlert } from '@/components/form-alert';
import { SubmitButton } from '@/components/submit-button';
import { problemMessage, type MessageOverrides } from '@/lib/problem';

export interface ConfirmDialogProps {
  /** The button that opens the dialog. */
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  /** Performs the action; a rejection is shown in the dialog, which stays open. */
  onConfirm: () => Promise<unknown>;
  messages?: MessageOverrides;
}

/** A yes/no confirmation (restore, delete) without a reason field. */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  pendingLabel,
  destructive = false,
  onConfirm,
  messages,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await onConfirm();
      setOpen(false);
    } catch (err) {
      setError(problemMessage(err, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) setError(undefined);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form noValidate onSubmit={(event) => void confirm(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FormAlert message={error} />
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
              autoFocus
            >
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
