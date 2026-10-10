'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import {
  COURSE_LANGUAGE_LABELS,
  COURSE_LANGUAGES,
  COURSE_LEVEL_LABELS,
  COURSE_LEVELS,
  COURSE_READINESS_RULES,
  ErrorCode,
  type CourseDetail,
  type UpdateCourseRequest,
} from '@udemy/contracts';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';
import { NativeSelect } from '@udemy/ui/components/native-select';

import { CategorySelect } from '@/components/category-select';
import { FormAlert } from '@/components/form-alert';
import { MarkdownEditor } from '@/components/markdown-editor';
import { SubmitButton } from '@/components/submit-button';
import { catalogApi } from '@/lib/catalog-api';
import { catalogKeys, setCourseData, useCategories } from '@/lib/catalog-queries';
import { applyServerError } from '@/lib/form';
import { markdownIssues, type MarkdownIssueView } from '@/lib/markdown-issues';
import { hasCode, problemMessage } from '@/lib/problem';
import { formResolver } from '@/lib/zod-messages';

import { BulletListEditor } from './bullet-list-editor';
import { DetailsFormSchema, toFormValues, toPatch, type DetailsFormOutput } from './details-form';
import { ThumbnailField } from './thumbnail-field';
import { VersionConflictAlert } from './version-conflict-alert';

/**
 * Details tab (design §10): title, subtitle, description (markdown with live preview), language,
 * level, category, URL slug, outcomes and requirements, course image. Saves only the changed
 * fields with `expectedVersion`; a 409 `version_conflict` asks to reload.
 */
export function DetailsTab({ course, readOnly }: { course: CourseDetail; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const categories = useCategories();
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [descriptionIssues, setDescriptionIssues] = useState<MarkdownIssueView[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const form = useForm({
    resolver: formResolver(DetailsFormSchema),
    defaultValues: toFormValues(course),
  });
  const { register, handleSubmit, formState, setError, reset, control } = form;

  const save = useMutation({
    mutationFn: (patch: UpdateCourseRequest) => catalogApi.updateCourse(course.id, patch),
    onSuccess: (updated) => {
      setCourseData(queryClient, updated);
      reset(toFormValues(updated));
      setDescriptionIssues(null);
      setSaved('All changes saved.');
    },
    onError: (error) => {
      setSaved(null);
      if (hasCode(error, ErrorCode.VersionConflict)) {
        setConflict(true);
        return;
      }
      if (hasCode(error, ErrorCode.CourseInReview) || hasCode(error, ErrorCode.CourseNotEditable)) {
        void queryClient.invalidateQueries({ queryKey: catalogKeys.course(course.id), exact: true });
      }
      const issues = markdownIssues(error, 'descriptionMd');
      if (issues) {
        setDescriptionIssues(issues);
        setError('descriptionMd', { type: 'server', message: problemMessage(error) }, { shouldFocus: true });
        return;
      }
      applyServerError(setError, error, {
        fields: [
          'title',
          'subtitle',
          'descriptionMd',
          'language',
          'level',
          'categoryId',
          'slug',
          'outcomes',
          'requirements',
        ],
        codeFields: {
          [ErrorCode.SlugTaken]: 'slug',
          [ErrorCode.SlugFrozen]: 'slug',
          [ErrorCode.CategoryInactive]: 'categoryId',
          [ErrorCode.CategoryNotLeaf]: 'categoryId',
          [ErrorCode.CategoryNotFound]: 'categoryId',
        },
      });
    },
  });

  async function reload() {
    setReloading(true);
    try {
      const fresh = await queryClient.fetchQuery({
        queryKey: catalogKeys.course(course.id),
        queryFn: () => catalogApi.course(course.id),
        staleTime: 0,
      });
      reset(toFormValues(fresh));
      setConflict(false);
      setDescriptionIssues(null);
    } catch (error) {
      setError('root.server', { type: 'server', message: problemMessage(error) });
    } finally {
      setReloading(false);
    }
  }

  function onSubmit(values: DetailsFormOutput) {
    // The newest version this tab knows (curriculum edits bump it too).
    const latest = queryClient.getQueryData<CourseDetail>(catalogKeys.course(course.id)) ?? course;
    const patch = toPatch(values, latest);
    if (!patch) {
      setSaved('Nothing to save: no changes.');
      return;
    }
    save.mutate(patch);
  }

  const errors = formState.errors;
  const disabled = readOnly || conflict;

  return (
    <div className="grid gap-10">
      <form noValidate onSubmit={handleSubmit(onSubmit)} className="grid gap-6" aria-labelledby="details-heading">
        <h2 id="details-heading" className="sr-only">
          Course details
        </h2>
        {conflict ? <VersionConflictAlert onReload={() => void reload()} reloading={reloading} /> : null}
        <FormAlert message={errors.root?.server?.message} />
        <fieldset disabled={disabled} className="grid gap-6">
          <FormField id="course-title" label="Title" description="5–60 characters." error={errors.title?.message}>
            {(field) => <Input {...field} maxLength={60} {...register('title')} />}
          </FormField>
          <FormField
            id="course-subtitle"
            label="Subtitle"
            description="10–120 characters: what the course is about in one sentence."
            error={errors.subtitle?.message}
          >
            {(field) => <Input {...field} maxLength={120} {...register('subtitle')} />}
          </FormField>
          <Controller
            control={control}
            name="descriptionMd"
            render={({ field, fieldState }) => (
              <MarkdownEditor
                id="course-descriptionMd"
                label="Description"
                description={`Markdown. At least ${COURSE_READINESS_RULES.minDescriptionChars} characters of text before you can submit. No HTML, images or relative links.`}
                value={field.value}
                onChange={(value) => {
                  field.onChange(value);
                  if (descriptionIssues) setDescriptionIssues(null);
                }}
                onBlur={field.onBlur}
                name={field.name}
                textareaRef={field.ref}
                disabled={disabled}
                maxLength={20_000}
                error={fieldState.error?.message}
                issues={descriptionIssues}
              />
            )}
          />
          <div className="grid gap-6 md:grid-cols-3">
            <FormField id="course-language" label="Language" error={errors.language?.message}>
              {(field) => (
                <NativeSelect {...field} {...register('language')}>
                  <option value="">Choose a language</option>
                  {COURSE_LANGUAGES.map((code) => (
                    <option key={code} value={code} lang={code}>
                      {COURSE_LANGUAGE_LABELS[code]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField id="course-level" label="Level" error={errors.level?.message}>
              {(field) => (
                <NativeSelect {...field} {...register('level')}>
                  <option value="">Choose a level</option>
                  {COURSE_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {COURSE_LEVEL_LABELS[level]}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField
              id="course-categoryId"
              label="Category"
              error={errors.categoryId?.message}
              description={categories.isError ? 'Categories could not be loaded.' : undefined}
            >
              {(field) => (
                <CategorySelect {...field} categories={categories.data?.items ?? []} {...register('categoryId')} />
              )}
            </FormField>
          </div>
          <FormField
            id="course-slug"
            label="Course URL"
            description={
              course.slugEditable
                ? 'Lowercase letters, digits and hyphens. It cannot change after the first publication.'
                : 'The URL is fixed since the course was first published.'
            }
            error={errors.slug?.message}
          >
            {(field) => (
              <Input {...field} readOnly={!course.slugEditable} maxLength={60} {...register('slug')} />
            )}
          </FormField>
          <BulletListEditor
            name="outcomes"
            legend="What students will learn"
            description={`At least ${COURSE_READINESS_RULES.minOutcomes} learning outcomes, one short sentence each.`}
            itemLabel="Outcome"
            placeholder="e.g. Build a REST API with NestJS"
            control={control}
            register={register}
            errors={errors}
            disabled={disabled}
          />
          <BulletListEditor
            name="requirements"
            legend="Requirements"
            description="What students need before they start (optional)."
            itemLabel="Requirement"
            placeholder="e.g. Basic JavaScript"
            control={control}
            register={register}
            errors={errors}
            disabled={disabled}
          />
        </fieldset>
        {readOnly ? null : (
          <div className="flex flex-wrap items-center gap-4">
            <SubmitButton pending={save.isPending} pendingLabel="Saving…" disabled={conflict}>
              Save details
            </SubmitButton>
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {saved}
            </p>
          </div>
        )}
      </form>
      <ThumbnailField course={course} readOnly={readOnly} />
    </div>
  );
}
