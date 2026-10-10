'use client';

import type { ComponentProps } from 'react';
import type { CategoryNode } from '@udemy/contracts';
import { NativeSelect } from '@udemy/ui/components/native-select';

/**
 * Two-level category picker (design §4): top-level groups are `<optgroup>`s, only their
 * subcategories (the active depth-2 leaves a course may use) can be chosen. Native, so it is
 * keyboard and screen-reader friendly and works with react-hook-form's `register`.
 */
export function CategorySelect({
  categories,
  placeholder = 'Choose a category',
  ...props
}: ComponentProps<typeof NativeSelect> & { categories: CategoryNode[]; placeholder?: string }) {
  return (
    <NativeSelect {...props}>
      <option value="">{placeholder}</option>
      {categories.map((group) => (
        <optgroup key={group.id} label={group.name}>
          {group.children.map((leaf) => (
            <option key={leaf.id} value={leaf.id}>
              {leaf.name}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  );
}
