'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import {
  ErrorCode,
  EXPERIENCE_LEVELS,
  HttpsUrlSchema,
  InstructorApplicationSchema,
  SubmitInstructorApplicationRequestSchema,
  type SubmitInstructorApplicationRequest,
} from '@udemy/contracts';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { Textarea } from '@udemy/ui/components/textarea';

import { FormAlert } from '@/components/form-alert';
import { SubmitButton } from '@/components/submit-button';
import { api } from '@/lib/api';
import { applyServerError } from '@/lib/form';
import { hasCode } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';
import { formResolver } from '@/lib/zod-messages';

import { EXPERIENCE_LABEL } from './labels';

const MOTIVATION_MIN = 100;
const MOTIVATION_MAX = 3000;

/** The contract, except that an empty portfolio field means "none" (omitted from the body). */
const ApplicationFormSchema = SubmitInstructorApplicationRequestSchema.extend({
  portfolioUrl: z
    .string()
    .transform((value) => (value.trim() === '' ? undefined : value))
    .pipe(HttpsUrlSchema.optional()),
});

export function ApplicationForm() {
  const queryClient = useQueryClient();
  const { register, handleSubmit, formState, setError, control } = useForm({
    resolver: formResolver(ApplicationFormSchema),
    defaultValues: { motivation: '', expertise: '', portfolioUrl: '' },
  });

  const submit = useMutation({
    mutationFn: (body: SubmitInstructorApplicationRequest) =>
      api('/me/instructor-applications', {
        method: 'POST',
        json: body,
        schema: InstructorApplicationSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.myApplications }),
    onError: (error) => {
      // The page state is out of date: refetch and let it show the right view.
      if (
        hasCode(error, ErrorCode.EmailNotVerified) ||
        hasCode(error, ErrorCode.AlreadyInstructor)
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.me, exact: true });
      }
      if (hasCode(error, ErrorCode.ApplicationAlreadyPending)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.myApplications });
      }
      applyServerError(setError, error, {
        fields: ['motivation', 'expertise', 'experienceLevel', 'portfolioUrl'],
      });
    },
  });

  const motivationLength = useWatch({ control, name: 'motivation' }).trim().length;
  const pending = submit.isPending || submit.isSuccess;

  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) => submit.mutate(values))}
      className="grid gap-6"
      aria-busy={pending}
    >
      <FormAlert message={formState.errors.root?.server?.message} />

      <FormField
        id="expertise"
        label="What will you teach?"
        description="Your main topic, e.g. “Web development with TypeScript”."
        error={formState.errors.expertise?.message}
      >
        {(field) => <Input {...field} maxLength={200} {...register('expertise')} />}
      </FormField>

      <FormField
        id="experienceLevel"
        label="Teaching experience"
        error={formState.errors.experienceLevel?.message}
      >
        {(field) => (
          <NativeSelect {...field} defaultValue="" {...register('experienceLevel')}>
            <option value="" disabled>
              Select your experience…
            </option>
            {EXPERIENCE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {EXPERIENCE_LABEL[level]}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>

      <FormField
        id="motivation"
        label="Why do you want to teach?"
        hint={`${motivationLength} / ${MOTIVATION_MAX}`}
        description={`At least ${MOTIVATION_MIN} characters. Who are your learners, and what will they be able to do after your course?`}
        error={formState.errors.motivation?.message}
      >
        {(field) => <Textarea {...field} rows={8} {...register('motivation')} />}
      </FormField>

      <FormField
        id="portfolioUrl"
        label="Portfolio or website"
        hint="Optional"
        description="An https:// link to your work: a website, GitHub, YouTube channel…"
        error={formState.errors.portfolioUrl?.message}
      >
        {(field) => (
          <Input
            {...field}
            type="url"
            inputMode="url"
            placeholder="https://"
            {...register('portfolioUrl')}
          />
        )}
      </FormField>

      <div className="flex justify-end">
        <SubmitButton pending={pending} pendingLabel="Submitting…">
          Submit application
        </SubmitButton>
      </div>
    </form>
  );
}
