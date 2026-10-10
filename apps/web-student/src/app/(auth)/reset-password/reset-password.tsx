'use client';

import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ErrorCode, NewPasswordSchema, ResetPasswordRequestSchema } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { FormField } from '@udemy/ui/components/form-field';
import { Spinner } from '@udemy/ui/components/spinner';

import { AuthCard } from '@/components/auth-card';
import { FormAlert } from '@/components/form-alert';
import { PasswordInput } from '@/components/password-input';
import { SubmitButton } from '@/components/submit-button';
import { api } from '@/lib/api';
import { applyServerError } from '@/lib/form';
import { hasCode } from '@/lib/problem';
import { useFragmentToken } from '@/lib/use-fragment-token';
import { formResolver } from '@/lib/zod-messages';

const ResetPasswordFormSchema = z
  .object({ newPassword: NewPasswordSchema, confirmPassword: z.string() })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The passwords do not match.',
  });
type ResetPasswordFormValues = z.output<typeof ResetPasswordFormSchema>;

function InvalidLink() {
  return (
    <AuthCard
      title="This link does not work"
      description="The reset link is invalid, has expired or has already been used."
    >
      <div role="alert" className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Reset links are valid for 30 minutes, work once, and stop working when the password
          changes. Request a new one to continue.
        </p>
        <Button asChild>
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    </AuthCard>
  );
}

export function ResetPassword() {
  const fragment = useFragmentToken();
  const { register, handleSubmit, formState, setError } = useForm({
    resolver: formResolver(ResetPasswordFormSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  const reset = useMutation({
    mutationFn: ({ newPassword }: ResetPasswordFormValues) => {
      const token = fragment.status === 'ready' ? fragment.token : null;
      return api('/auth/password/reset', {
        method: 'POST',
        json: ResetPasswordRequestSchema.parse({ token, newPassword }),
        quiet: true,
      });
    },
    onError: (error) =>
      applyServerError(setError, error, {
        fields: ['newPassword', 'confirmPassword'],
        codeFields: { [ErrorCode.WeakPassword]: 'newPassword' },
      }),
  });

  if (fragment.status === 'reading') {
    return (
      <AuthCard title="Choose a new password">
        <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner />
          Loading…
        </div>
      </AuthCard>
    );
  }

  if (!fragment.token || hasCode(reset.error, ErrorCode.InvalidToken)) return <InvalidLink />;

  if (reset.isSuccess) {
    return (
      <AuthCard
        title="Password changed"
        description="Your password has been updated and you were signed out on all devices."
      >
        <div role="status" className="grid gap-4">
          <Button asChild>
            <Link href="/login">Log in with your new password</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      description="Use at least 10 characters. A short phrase is easy to remember and hard to guess."
    >
      <form
        noValidate
        onSubmit={handleSubmit((values) => reset.mutate(values))}
        className="grid gap-5"
        aria-busy={reset.isPending}
      >
        <FormAlert message={formState.errors.root?.server?.message} />
        <FormField
          id="newPassword"
          label="New password"
          error={formState.errors.newPassword?.message}
        >
          {(field) => (
            <PasswordInput
              {...field}
              autoComplete="new-password"
              autoFocus
              {...register('newPassword')}
            />
          )}
        </FormField>
        <FormField
          id="confirmPassword"
          label="Confirm new password"
          error={formState.errors.confirmPassword?.message}
        >
          {(field) => (
            <PasswordInput
              {...field}
              autoComplete="new-password"
              {...register('confirmPassword')}
            />
          )}
        </FormField>
        <SubmitButton pending={reset.isPending} pendingLabel="Saving…" className="w-full">
          Set new password
        </SubmitButton>
      </form>
    </AuthCard>
  );
}
