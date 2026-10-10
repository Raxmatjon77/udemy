import type { Metadata } from 'next';

import { CategoriesManager } from './categories-manager';

export const metadata: Metadata = { title: 'Categories' };

export default function CategoriesPage() {
  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Categories</h1>
        <p className="text-sm text-muted-foreground">
          The catalog’s two-level tree: groups, and the subcategories courses are filed under.
          Inactive categories are hidden from students and cannot be picked for new submissions.
        </p>
      </div>
      <CategoriesManager />
    </>
  );
}
