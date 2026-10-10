'use client';

import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { ForgotPasswordRequestSchema, type ForgotPasswordRequest } from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';

import { FormAlert } from '@/components/form-alert';
import { SubmitButton } from '@/components/submit-button';
import { api } from '@/lib/api';
import { applyServerError } from '@/lib/form';
import { formResolver } from '@/lib/zod-messages';

export function ForgotPasswordForm() {
  const { register, handleSubmit, formState, setError, getValues } = useForm({
    resolver: formResolver(ForgotPasswordRequestSchema),
    defaultValues: { email: '' },
  });

  const request = useMutation({
    // Always 202, whether or not the account exists (no enumeration).
    mutationFn: (values: ForgotPasswordRequest) =>
      api('/auth/password/forgot', { method: 'POST', json: values }),
    onError: (error) => applyServerError(setError, error, { fields: ['email'] }),
  });

  if (request.isSuccess) {
    return (
      <div role="status">
        <Alert variant="success">
          <AlertTitle>Check your inbox</AlertTitle>
          <AlertDescription>
            <p>
              If an account exists for <strong>{getValues('email')}</strong>, we have sent a link to
              reset its password. The link is valid for 30 minutes.
            </p>
            <p>Did not get it? Check your spam folder, or try again in a few minutes.</p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) => request.mutate(values))}
      className="grid gap-5"
      aria-busy={request.isPending}
    >
      <FormAlert message={formState.errors.root?.server?.message} />
      <FormField id="email" label="Email" error={formState.errors.email?.message}>
        {(field) => (
          <Input
            {...field}
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            {...register('email')}
          />
        )}
      </FormField>
      <SubmitButton pending={request.isPending} pendingLabel="Sending…" className="w-full">
        Send reset link
      </SubmitButton>
    </form>
  );
}
