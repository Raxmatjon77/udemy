'use client';

import {
  useFieldArray,
  type Control,
  type FieldErrors,
  type UseFormRegister,
} from 'react-hook-form';
import { CURRICULUM_LIMITS } from '@udemy/contracts';
import { Button } from '@udemy/ui/components/button';
import { Input } from '@udemy/ui/components/input';

import type { DetailsFormInput } from './details-form';

type ListName = 'outcomes' | 'requirements';

/**
 * An ordered list of one-line bullets (outcomes / requirements, ≤ 10 × 1–160 characters) with
 * add, remove and move up/down buttons: plain buttons, so it is fully keyboard operable.
 */
export function BulletListEditor({
  name,
  legend,
  description,
  itemLabel,
  placeholder,
  control,
  register,
  errors,
  disabled,
}: {
  name: ListName;
  legend: string;
  description: string;
  itemLabel: string;
  placeholder: string;
  control: Control<DetailsFormInput>;
  register: UseFormRegister<DetailsFormInput>;
  errors: FieldErrors<DetailsFormInput>;
  disabled: boolean;
}) {
  const { fields, append, remove, move } = useFieldArray({ control, name });
  const max = CURRICULUM_LIMITS.maxBulletsPerKind;
  const listErrors = errors[name];
  const descriptionId = `course-${name}-description`;

  return (
    <fieldset
      id={`course-${name}`}
      tabIndex={-1}
      className="grid gap-3 rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-describedby={descriptionId}
    >
      <legend className="text-sm font-medium">{legend}</legend>
      <p id={descriptionId} className="text-xs text-muted-foreground">
        {description} ({fields.length} / {max})
      </p>
      {listErrors?.root?.message || listErrors?.message ? (
        <p className="text-sm text-destructive">{listErrors.root?.message ?? listErrors.message}</p>
      ) : null}
      <ol className="grid gap-2">
        {fields.map((field, index) => {
          const id = `course-${name}-${index}`;
          const error = listErrors?.[index]?.value?.message;
          return (
            <li key={field.id} className="grid gap-1">
              <div className="flex items-center gap-2">
                <label htmlFor={id} className="sr-only">
                  {itemLabel} {index + 1}
                </label>
                <Input
                  id={id}
                  placeholder={placeholder}
                  maxLength={160}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? `${id}-error` : undefined}
                  {...register(`${name}.${index}.value`)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled || index === 0}
                  onClick={() => move(index, index - 1)}
                  aria-label={`Move ${itemLabel.toLowerCase()} ${index + 1} up`}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled || index === fields.length - 1}
                  onClick={() => move(index, index + 1)}
                  aria-label={`Move ${itemLabel.toLowerCase()} ${index + 1} down`}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => remove(index)}
                  aria-label={`Remove ${itemLabel.toLowerCase()} ${index + 1}`}
                >
                  ✕
                </Button>
              </div>
              {error ? (
                <p id={`${id}-error`} className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || fields.length >= max}
          onClick={() => append({ value: '' }, { shouldFocus: true })}
        >
          Add {itemLabel.toLowerCase()}
        </Button>
      </div>
    </fieldset>
  );
}
