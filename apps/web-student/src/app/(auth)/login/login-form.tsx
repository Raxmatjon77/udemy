'use client';

import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { LoginRequestSchema, type LoginRequest } from '@udemy/contracts';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';
import { safeNextPath } from '@udemy/web-auth/client';

import { FormAlert } from '@/components/form-alert';
import { PasswordInput } from '@/components/password-input';
import { SubmitButton } from '@/components/submit-button';
import { authPost } from '@/lib/api';
import { applyServerError } from '@/lib/form';
import { hasCode } from '@/lib/problem';
import { formResolver } from '@/lib/zod-messages';

export function LoginForm({ next }: { next: string }) {
  const form = useForm({
    resolver: formResolver(LoginRequestSchema),
    defaultValues: { email: '', password: '' },
  });
  const { register, handleSubmit, formState, setError, setValue, setFocus } = form;

  const login = useMutation({
    mutationFn: (values: LoginRequest) => authPost('login', values),
    onSuccess: () => {
      // A full navigation, so every server component renders with the new session.
      // `next` was validated on the server; check again in case this component is reused.
      window.location.assign(safeNextPath(next, '/'));
    },
    onError: (error) => {
      if (hasCode(error, 'invalid_credentials')) {
        setValue('password', '');
        setFocus('password');
      }
      applyServerError(setError, error, { fields: ['email', 'password'] });
    },
  });

  const pending = login.isPending || login.isSuccess;

  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) => login.mutate(values))}
      className="grid gap-5"
      aria-busy={pending}
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

      <FormField
        id="password"
        label="Password"
        error={formState.errors.password?.message}
        hint={
          <Link
            href="/forgot-password"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Forgot password?
          </Link>
        }
      >
        {(field) => (
          <PasswordInput {...field} autoComplete="current-password" {...register('password')} />
        )}
      </FormField>

      <SubmitButton pending={pending} pendingLabel="Logging in…" className="w-full">
        Log in
      </SubmitButton>
    </form>
  );
}
