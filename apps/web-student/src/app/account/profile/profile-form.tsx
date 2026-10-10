'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import {
  BioSchema,
  DisplayNameSchema,
  HeadlineSchema,
  ProfileSchema,
  type Profile,
  type UpdateProfileRequest,
} from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Button } from '@udemy/ui/components/button';
import { Card, CardContent, CardFooter } from '@udemy/ui/components/card';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Textarea } from '@udemy/ui/components/textarea';

import { FormAlert } from '@/components/form-alert';
import { SubmitButton } from '@/components/submit-button';
import { api } from '@/lib/api';
import { applyServerError } from '@/lib/form';
import { problemMessage } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';
import { formResolver } from '@/lib/zod-messages';

/** An empty optional text field means "clear it" (`null` in the PATCH body). */
const blankToNull = (value: string) => (value.trim() === '' ? null : value);

const ProfileFormSchema = z.object({
  displayName: DisplayNameSchema,
  headline: z.string().transform(blankToNull).pipe(HeadlineSchema.nullable()),
  bio: z.string().transform(blankToNull).pipe(BioSchema.nullable()),
});
type ProfileFormInput = z.input<typeof ProfileFormSchema>;
type ProfileFormOutput = z.output<typeof ProfileFormSchema>;

function toFormValues(profile: Profile): ProfileFormInput {
  return {
    displayName: profile.displayName,
    headline: profile.headline ?? '',
    bio: profile.bio ?? '',
  };
}

const BIO_MAX = 4000;

export function ProfileForm() {
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: queryKeys.profile,
    queryFn: () => api('/me/profile', { schema: ProfileSchema }),
  });

  const { register, handleSubmit, formState, setError, reset, control } = useForm({
    resolver: formResolver(ProfileFormSchema),
    defaultValues: { displayName: '', headline: '', bio: '' },
  });

  const bioLength = useWatch({ control, name: 'bio' }).length;

  useEffect(() => {
    if (profile.data) reset(toFormValues(profile.data));
  }, [profile.data, reset]);

  const save = useMutation({
    mutationFn: (body: UpdateProfileRequest) =>
      api('/me/profile', { method: 'PATCH', json: body, schema: ProfileSchema }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.profile, updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.me, exact: true });
      reset(toFormValues(updated));
    },
    onError: (error) =>
      applyServerError(setError, error, { fields: ['displayName', 'headline', 'bio'] }),
  });

  const onSubmit = (values: ProfileFormOutput) => {
    // Send only what changed: PATCH semantics, and no accidental overwrite of other edits.
    const body: UpdateProfileRequest = {};
    if (formState.dirtyFields.displayName) body.displayName = values.displayName;
    if (formState.dirtyFields.headline) body.headline = values.headline;
    if (formState.dirtyFields.bio) body.bio = values.bio;
    if (Object.keys(body).length > 0) save.mutate(body);
  };

  if (profile.isPending) {
    return (
      <Card aria-busy="true" aria-label="Loading profile">
        <CardContent className="grid gap-6">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (profile.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {problemMessage(profile.error)}
          <Button size="sm" variant="outline" onClick={() => void profile.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <form noValidate onSubmit={handleSubmit(onSubmit)} aria-busy={save.isPending}>
        <CardContent className="grid gap-6">
          <FormAlert message={formState.errors.root?.server?.message} />
          <div role="status" aria-live="polite">
            {save.isSuccess && !formState.isDirty ? (
              <Alert variant="success">
                <AlertDescription>Your profile has been saved.</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <FormField
            id="displayName"
            label="Display name"
            description="Shown on your reviews, questions and, if you teach, your courses."
            error={formState.errors.displayName?.message}
          >
            {(field) => <Input {...field} autoComplete="name" {...register('displayName')} />}
          </FormField>

          <FormField
            id="headline"
            label="Headline"
            hint="Optional"
            description="One line about you, e.g. “Backend engineer learning data science”."
            error={formState.errors.headline?.message}
          >
            {(field) => <Input {...field} maxLength={60} {...register('headline')} />}
          </FormField>

          <FormField
            id="bio"
            label="About you"
            hint={`${bioLength} / ${BIO_MAX}`}
            description="Plain text. Leave empty to remove it."
            error={formState.errors.bio?.message}
          >
            {(field) => <Textarea {...field} rows={6} {...register('bio')} />}
          </FormField>
        </CardContent>
        <CardFooter className="mt-6 justify-end gap-3 border-t pt-6">
          <Button
            variant="ghost"
            disabled={!formState.isDirty || save.isPending}
            onClick={() => reset(toFormValues(profile.data))}
          >
            Discard changes
          </Button>
          <SubmitButton
            pending={save.isPending}
            pendingLabel="Saving…"
            disabled={!formState.isDirty}
          >
            Save profile
          </SubmitButton>
        </CardFooter>
      </form>
    </Card>
  );
}
