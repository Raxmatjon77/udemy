'use client';

import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { ErrorCode, LoginRequestSchema, type LoginRequest } from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
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

export function LoginForm({
  next,
  becomeInstructorUrl,
}: {
  next: string;
  becomeInstructorUrl: string;
}) {
  const { register, handleSubmit, formState, setError, setValue, setFocus } = useForm({
    resolver: formResolver(LoginRequestSchema),
    defaultValues: { email: '', password: '' },
  });

  const login = useMutation({
    mutationFn: (values: LoginRequest) => authPost('login', values),
    // A full navigation, so every server component renders with the new session.
    onSuccess: () => window.location.assign(safeNextPath(next, '/')),
    onError: (error) => {
      // A correct password for an account without the INSTRUCTOR role: explained below.
      if (hasCode(error, ErrorCode.AppAccessDenied)) return;
      if (hasCode(error, ErrorCode.InvalidCredentials)) {
        setValue('password', '');
        setFocus('password');
      }
      applyServerError(setError, error, { fields: ['email', 'password'] });
    },
  });

  const pending = login.isPending || login.isSuccess;
  const notInstructor = hasCode(login.error, ErrorCode.AppAccessDenied);

  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) => login.mutate(values))}
      className="grid gap-5"
      aria-busy={pending}
    >
      {notInstructor ? (
        <div role="alert">
          <Alert variant="warning">
            <AlertTitle>This account is not an instructor yet</AlertTitle>
            <AlertDescription>
              <p>
                Instructor tools are available once your application has been approved.{' '}
                <a href={becomeInstructorUrl} className="font-medium underline underline-offset-4">
                  Apply to become an instructor
                </a>
              </p>
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <FormAlert message={formState.errors.root?.server?.message} />
      )}

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
