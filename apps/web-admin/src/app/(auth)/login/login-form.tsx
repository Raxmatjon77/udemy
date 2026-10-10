'use client';

import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { ErrorCode, LoginRequestSchema, type LoginRequest } from '@udemy/contracts';
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
  const { register, handleSubmit, formState, setError, setValue, setFocus } = useForm({
    resolver: formResolver(LoginRequestSchema),
    defaultValues: { email: '', password: '' },
  });

  const login = useMutation({
    mutationFn: (values: LoginRequest) => authPost('login', values),
    // A full navigation, so every server component renders with the new session.
    onSuccess: () => window.location.assign(safeNextPath(next, '/instructor-applications')),
    onError: (error) => {
      if (hasCode(error, ErrorCode.InvalidCredentials)) {
        setValue('password', '');
        setFocus('password');
      }
      applyServerError(setError, error, {
        fields: ['email', 'password'],
        messages: {
          [ErrorCode.AppAccessDenied]: 'This account is not an administrator.',
        },
      });
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

      <FormField id="password" label="Password" error={formState.errors.password?.message}>
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
