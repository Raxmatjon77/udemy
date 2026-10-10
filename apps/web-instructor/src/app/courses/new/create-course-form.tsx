'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { CourseTitleSchema, ErrorCode, UuidSchema } from '@udemy/contracts';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';

import { CategorySelect } from '@/components/category-select';
import { FormAlert } from '@/components/form-alert';
import { SubmitButton } from '@/components/submit-button';
import { catalogApi } from '@/lib/catalog-api';
import { catalogKeys, setCourseData, useCategories } from '@/lib/catalog-queries';
import { applyServerError } from '@/lib/form';
import { formResolver } from '@/lib/zod-messages';

const CreateCourseFormSchema = z.object({
  title: CourseTitleSchema,
  categoryId: z.union([z.literal(''), UuidSchema]),
});

/** Title + category → `POST /instructor/courses` → the builder of the new course. */
export function CreateCourseForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const categories = useCategories();
  const { register, handleSubmit, formState, setError } = useForm({
    resolver: formResolver(CreateCourseFormSchema),
    defaultValues: { title: '', categoryId: '' },
  });

  const create = useMutation({
    mutationFn: (values: z.output<typeof CreateCourseFormSchema>) =>
      catalogApi.createCourse({
        title: values.title,
        ...(values.categoryId ? { categoryId: values.categoryId } : {}),
      }),
    onSuccess: (course) => {
      setCourseData(queryClient, course);
      void queryClient.invalidateQueries({ queryKey: catalogKeys.myCoursesAll });
      router.push(`/courses/${course.id}`);
    },
    onError: (error) =>
      applyServerError(setError, error, {
        fields: ['title', 'categoryId'],
        codeFields: {
          [ErrorCode.CategoryInactive]: 'categoryId',
          [ErrorCode.CategoryNotLeaf]: 'categoryId',
          [ErrorCode.CategoryNotFound]: 'categoryId',
        },
      }),
  });
  const pending = create.isPending || create.isSuccess;

  return (
    <form
      noValidate
      onSubmit={handleSubmit((values) => create.mutate(values))}
      className="grid gap-5"
      aria-busy={pending}
    >
      <FormAlert message={formState.errors.root?.server?.message} />
      <FormField
        id="title"
        label="Working title"
        description="5–60 characters. You can change it later."
        error={formState.errors.title?.message}
      >
        {(field) => <Input {...field} autoFocus maxLength={60} {...register('title')} />}
      </FormField>
      <FormField
        id="categoryId"
        label="Category"
        hint="Optional"
        description={
          categories.isError ? 'Categories could not be loaded; you can choose one later.' : undefined
        }
        error={formState.errors.categoryId?.message}
      >
        {(field) => (
          <CategorySelect
            {...field}
            categories={categories.data?.items ?? []}
            disabled={!categories.data}
            {...register('categoryId')}
          />
        )}
      </FormField>
      <div>
        <SubmitButton pending={pending} pendingLabel="Creating…">
          Create course
        </SubmitButton>
      </div>
    </form>
  );
}
