'use client';

import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { SignupRequestSchema, SignupResponseSchema, type SignupRequest } from '@udemy/contracts';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';

import { FormAlert } from '@/components/form-alert';
import { PasswordInput } from '@/components/password-input';
import { SubmitButton } from '@/components/submit-button';
import { api } from '@/lib/api';
import { applyServerError } from '@/lib/form';
import { formResolver } from '@/lib/zod-messages';

export function SignupForm() {
  const router = useRouter();
  const { register, handleSubmit, formState, setError } = useForm({
    resolver: formResolver(SignupRequestSchema),
    defaultValues: { displayName: '', email: '', password: '' },
  });

  const signup = useMutation({
    // 202 for new AND existing emails (no account enumeration): always "check your inbox".
    mutationFn: (values: SignupRequest) =>
      api('/auth/signup', { method: 'POST', json: values, schema: SignupResponseSchema }),
    onSuccess: () => router.push('/verify-email/pending?from=signup'),
    onError: (error) =>
      applyServerError(setError, error, {
        fields: ['displayName', 'email', 'password'],
        codeFields: { weak_password: 'password' },
      }),
  });

  const pending = signup.isPending || signup.isSuccess;

  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) => signup.mutate(values))}
      className="grid gap-5"
      aria-busy={pending}
    >
      <FormAlert message={formState.errors.root?.server?.message} />

      <FormField id="displayName" label="Full name" error={formState.errors.displayName?.message}>
        {(field) => <Input {...field} autoComplete="name" autoFocus {...register('displayName')} />}
      </FormField>

      <FormField id="email" label="Email" error={formState.errors.email?.message}>
        {(field) => (
          <Input
            {...field}
            type="email"
            autoComplete="email"
            inputMode="email"
            {...register('email')}
          />
        )}
      </FormField>

      <FormField
        id="password"
        label="Password"
        description="At least 10 characters. A short phrase is easier to remember than a code."
        error={formState.errors.password?.message}
      >
        {(field) => (
          <PasswordInput {...field} autoComplete="new-password" {...register('password')} />
        )}
      </FormField>

      <SubmitButton pending={pending} pendingLabel="Creating your account…" className="w-full">
        Create account
      </SubmitButton>
    </form>
  );
}
