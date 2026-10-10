'use client';

import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  CategoryNameSchema,
  CategorySchema,
  ErrorCode,
  SLUG_MAX_LENGTH,
  SlugSchema,
  type AdminCategoryLeaf,
  type AdminCategoryNode,
  type CreateCategoryRequest,
  type UpdateCategoryRequest,
} from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@udemy/ui/components/dialog';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';
import { NativeSelect } from '@udemy/ui/components/native-select';

import { FormAlert } from '@/components/form-alert';
import { SubmitButton } from '@/components/submit-button';
import { api } from '@/lib/api';
import { applyServerError } from '@/lib/form';
import { hasCode, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';
import { formResolver } from '@/lib/zod-messages';

const FormSchema = z.object({
  name: CategoryNameSchema,
  /** Empty: generated from the name (create) or unchanged (edit). */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .refine((value) => value === '' || SlugSchema.safeParse(value).success, {
      message: `Lowercase letters, digits and single hyphens only, at most ${SLUG_MAX_LENGTH} characters.`,
    }),
  /** Subcategories only: the group it belongs to. */
  parentId: z.string(),
});
type FormValues = z.input<typeof FormSchema>;

const FORM_MESSAGES: MessageOverrides = {
  [ErrorCode.SlugTaken]: 'Another category already uses this slug.',
  [ErrorCode.CategoryNotFound]:
    'This category or its group was deleted in the meantime. Close this dialog; the tree was refreshed.',
};

export type CategoryFormTarget =
  | { mode: 'create'; parent: AdminCategoryNode | null }
  | { mode: 'edit'; category: AdminCategoryLeaf; groups: AdminCategoryNode[] };

/**
 * Create a group (no parent) or a subcategory, or edit a category's name, slug and, for a
 * subcategory, its group. An edit sends only the fields that changed (PATCH needs at least one).
 */
export function CategoryFormDialog({
  trigger,
  target,
  onSaved,
}: {
  trigger: ReactNode;
  target: CategoryFormTarget;
  /** Called after a successful save with a sentence for the live region. */
  onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const editing = target.mode === 'edit' ? target.category : null;
  const defaultValues: FormValues = {
    name: editing?.name ?? '',
    slug: editing?.slug ?? '',
    parentId: editing?.parentId ?? '',
  };
  const { register, handleSubmit, formState, setError, reset } = useForm({
    resolver: formResolver(FormSchema),
    defaultValues,
  });
  const pending = formState.isSubmitting;

  const submit = handleSubmit(async (values) => {
    try {
      if (target.mode === 'create') {
        const body: CreateCategoryRequest = {
          name: values.name,
          ...(values.slug ? { slug: values.slug } : {}),
          ...(target.parent ? { parentId: target.parent.id } : {}),
        };
        const created = await api('/admin/categories', {
          method: 'POST',
          json: body,
          schema: CategorySchema,
        });
        onSaved(`Created “${created.name}”.`);
      } else {
        const category = target.category;
        const body: UpdateCategoryRequest = {
          ...(values.name !== category.name ? { name: values.name } : {}),
          ...(values.slug && values.slug !== category.slug ? { slug: values.slug } : {}),
          ...(category.depth === 2 && values.parentId && values.parentId !== category.parentId
            ? { parentId: values.parentId }
            : {}),
        };
        if (Object.keys(body).length === 0) {
          setOpen(false);
          return;
        }
        const saved = await api(`/admin/categories/${encodeURIComponent(category.id)}`, {
          method: 'PATCH',
          json: body,
          schema: CategorySchema,
        });
        onSaved(`Saved “${saved.name}”.`);
      }
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
    } catch (error) {
      if (hasCode(error, ErrorCode.CategoryNotFound)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
      }
      applyServerError(setError, error, {
        fields: ['name', 'slug', 'parentId'],
        codeFields: { [ErrorCode.SlugTaken]: 'slug' },
        messages: FORM_MESSAGES,
      });
    }
  });

  let title: string;
  let description: string;
  if (target.mode === 'create') {
    title = target.parent ? `Add a subcategory to “${target.parent.name}”` : 'Add a group';
    description = target.parent
      ? 'Courses are filed under subcategories.'
      : 'Groups hold subcategories; courses cannot be filed under a group directly.';
  } else {
    title = `Edit “${target.category.name}”`;
    description = 'Changing the slug changes the category’s public URL; old links stop working.';
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        // Start from the category as it is now (the tree may have been refetched since mount).
        if (next) reset(defaultValues);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form noValidate onSubmit={submit} className="grid gap-4" aria-busy={pending}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <FormAlert message={formState.errors.root?.server?.message} />
          <FormField id="category-name" label="Name" error={formState.errors.name?.message}>
            {(field) => <Input {...field} maxLength={60} autoFocus {...register('name')} />}
          </FormField>
          <FormField
            id="category-slug"
            label="Slug"
            hint={target.mode === 'create' ? 'Optional' : undefined}
            description={
              target.mode === 'create'
                ? 'Leave empty to generate it from the name.'
                : 'Used in the public URL.'
            }
            error={formState.errors.slug?.message}
          >
            {(field) => (
              <Input
                {...field}
                maxLength={SLUG_MAX_LENGTH}
                autoCapitalize="none"
                spellCheck={false}
                {...register('slug')}
              />
            )}
          </FormField>
          {target.mode === 'edit' && target.category.depth === 2 ? (
            <FormField
              id="category-parent"
              label="Group"
              error={formState.errors.parentId?.message}
            >
              {(field) => (
                <NativeSelect {...field} {...register('parentId')}>
                  {target.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton pending={pending} pendingLabel="Saving…">
              {target.mode === 'create' ? 'Create' : 'Save'}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
