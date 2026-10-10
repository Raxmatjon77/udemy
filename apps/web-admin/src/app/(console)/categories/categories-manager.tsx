'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AdminCategoryTreeResponseSchema,
  CategorySchema,
  ErrorCode,
  type AdminCategoryLeaf,
  type AdminCategoryNode,
  type AdminCategoryTreeResponse,
  type ReorderCategoriesRequest,
} from '@udemy/contracts';
import { Alert, AlertDescription } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Card, CardContent } from '@udemy/ui/components/card';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { cn } from '@udemy/ui/lib/utils';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { QueryError } from '@/components/query-error';
import { api } from '@/lib/api';
import { problemMessage, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';

import { CategoryFormDialog } from './category-form-dialog';

type Direction = 'up' | 'down';

const byPosition = <T extends { position: number }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.position - b.position);

/** The tree with groups and each group's children in position order. */
function sortTree(tree: AdminCategoryTreeResponse): AdminCategoryNode[] {
  return byPosition(tree.items).map((group) => ({
    ...group,
    children: byPosition(group.children),
  }));
}

/** The tree with one sibling list (`parentId` null = the groups) replaced by `orderedIds`. */
function applyOrder(
  tree: AdminCategoryTreeResponse,
  { parentId, orderedIds }: ReorderCategoriesRequest,
): AdminCategoryTreeResponse {
  const reorder = <T extends { id: string; position: number }>(items: T[]): T[] => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return orderedIds.flatMap((id, position) => {
      const item = byId.get(id);
      return item ? [{ ...item, position }] : [];
    });
  };
  if (parentId === null) return { items: reorder(tree.items) };
  return {
    items: tree.items.map((group) =>
      group.id === parentId ? { ...group, children: reorder(group.children) } : group,
    ),
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function deleteMessages(category: AdminCategoryLeaf, childCount: number): MessageOverrides {
  const reasons: string[] = [];
  if (childCount > 0) reasons.push(`has ${plural(childCount, 'subcategory', 'subcategories')}`);
  if (category.courseCount > 0) {
    reasons.push(`is used by ${plural(category.courseCount, 'course', 'courses')}`);
  }
  const why = reasons.length > 0 ? reasons.join(' and ') : 'is still referenced by courses';
  return {
    [ErrorCode.CategoryInUse]: `“${category.name}” ${why} (including past course versions), so it cannot be deleted. Deactivate it instead: it disappears from the catalog and cannot be picked for new submissions, and existing courses keep it.`,
  };
}

interface RowProps {
  category: AdminCategoryLeaf;
  /** Number of children (groups only). */
  childCount?: number;
  index: number;
  siblingCount: number;
  groups: AdminCategoryNode[];
  onMove: (category: AdminCategoryLeaf, direction: Direction) => void;
  onToggle: (category: AdminCategoryLeaf) => void;
  onDelete: (category: AdminCategoryLeaf) => Promise<void>;
  onSaved: (message: string) => void;
}

function CategoryRow({
  category,
  childCount,
  index,
  siblingCount,
  groups,
  onMove,
  onToggle,
  onDelete,
  onSaved,
}: RowProps) {
  const isGroup = category.depth === 1;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2"
      data-testid={`category-${category.id}`}
    >
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className={cn('break-words', isGroup ? 'font-semibold' : 'font-medium')}>
            {category.name}
          </span>
          {category.isActive ? null : <Badge variant="outline">Inactive</Badge>}
        </span>
        <span className="text-xs text-muted-foreground">
          <span className="font-mono">{category.slug}</span>
          {' · '}
          {plural(category.courseCount, 'course', 'courses')}
          {isGroup && childCount !== undefined
            ? ` · ${plural(childCount, 'subcategory', 'subcategories')}`
            : ''}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={category.name}>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Move ${category.name} up`}
          data-focus-key={`${category.id}-up`}
          disabled={index === 0}
          onClick={() => onMove(category, 'up')}
        >
          <span aria-hidden="true">↑</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Move ${category.name} down`}
          data-focus-key={`${category.id}-down`}
          disabled={index === siblingCount - 1}
          onClick={() => onMove(category, 'down')}
        >
          <span aria-hidden="true">↓</span>
        </Button>
        <CategoryFormDialog
          trigger={
            <Button size="sm" variant="outline" aria-label={`Edit ${category.name}`}>
              Edit
            </Button>
          }
          target={{ mode: 'edit', category, groups }}
          onSaved={onSaved}
        />
        <Button
          size="sm"
          variant="outline"
          aria-label={`${category.isActive ? 'Deactivate' : 'Activate'} ${category.name}`}
          onClick={() => onToggle(category)}
        >
          {category.isActive ? 'Deactivate' : 'Activate'}
        </Button>
        <ConfirmDialog
          trigger={
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              aria-label={`Delete ${category.name}`}
            >
              Delete
            </Button>
          }
          title={`Delete “${category.name}”?`}
          description="Only a category no course has ever used can be deleted. This cannot be undone."
          confirmLabel="Delete category"
          pendingLabel="Deleting…"
          destructive
          onConfirm={() => onDelete(category)}
          messages={deleteMessages(category, childCount ?? 0)}
        />
      </div>
    </div>
  );
}

export function CategoriesManager() {
  const queryClient = useQueryClient();
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** `data-focus-key` of the control to focus after the next render (keeps focus on a move). */
  const focusKey = useRef<string | null>(null);

  const tree = useQuery({
    queryKey: queryKeys.categories,
    queryFn: () => api('/admin/categories', { schema: AdminCategoryTreeResponseSchema }),
  });

  useEffect(() => {
    if (!focusKey.current) return;
    const target = document.querySelector<HTMLElement>(`[data-focus-key="${focusKey.current}"]`);
    focusKey.current = null;
    target?.focus();
  });

  const announce = (message: string) => {
    setError(null);
    setAnnouncement(message);
  };
  const fail = (err: unknown, messages?: MessageOverrides) => {
    setAnnouncement('');
    setError(problemMessage(err, messages));
  };

  const reorder = useMutation({
    // Quick successive moves are sent one after the other, each a full sibling permutation.
    scope: { id: 'category-order' },
    mutationFn: (body: ReorderCategoriesRequest) =>
      api('/admin/categories/order', { method: 'PUT', json: body }),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.categories });
      const previous = queryClient.getQueryData<AdminCategoryTreeResponse>(queryKeys.categories);
      if (previous) {
        queryClient.setQueryData(queryKeys.categories, applyOrder(previous, body));
      }
      return { previous };
    },
    onError: (err, _body, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.categories, context.previous);
      fail(err);
      void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
    },
  });

  const toggle = useMutation({
    mutationFn: (category: AdminCategoryLeaf) =>
      api(`/admin/categories/${encodeURIComponent(category.id)}`, {
        method: 'PATCH',
        json: { isActive: !category.isActive },
        schema: CategorySchema,
      }),
    onSuccess: (saved) => {
      announce(
        saved.isActive
          ? `“${saved.name}” is active again.`
          : `“${saved.name}” was deactivated and is hidden from the catalog.`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
    },
    onError: (err) => {
      fail(err);
      void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
    },
  });

  if (tree.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading categories" className="grid gap-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  if (!tree.data) {
    return <QueryError error={tree.error} onRetry={() => void tree.refetch()} />;
  }

  const groups = sortTree(tree.data);

  const move = (
    category: AdminCategoryLeaf,
    siblings: readonly AdminCategoryLeaf[],
    direction: Direction,
  ) => {
    const from = siblings.findIndex((s) => s.id === category.id);
    const to = direction === 'up' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    const ids = siblings.map((s) => s.id);
    [ids[from], ids[to]] = [ids[to] as string, ids[from] as string];
    // Keep focus on the pressed button; at an end of the list it becomes disabled, so focus the
    // other direction instead.
    const atEdge = to === 0 || to === siblings.length - 1;
    const other: Direction = direction === 'up' ? 'down' : 'up';
    focusKey.current = `${category.id}-${atEdge ? other : direction}`;
    announce(`Moved “${category.name}” to position ${to + 1} of ${siblings.length}.`);
    reorder.mutate({ parentId: category.parentId, orderedIds: ids });
  };

  const remove = async (category: AdminCategoryLeaf) => {
    await api(`/admin/categories/${encodeURIComponent(category.id)}`, { method: 'DELETE' });
    announce(`Deleted “${category.name}”.`);
    await queryClient.invalidateQueries({ queryKey: queryKeys.categories });
  };

  const rowProps = {
    groups,
    onToggle: (category: AdminCategoryLeaf) => toggle.mutate(category),
    onDelete: remove,
    onSaved: (message: string) => announce(message),
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Use the arrow buttons to change the order students see.
        </p>
        <CategoryFormDialog
          trigger={<Button>Add group</Button>}
          target={{ mode: 'create', parent: null }}
          onSaved={announce}
        />
      </div>

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      <div role="alert" aria-live="assertive">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No categories yet. Add a group to start.
          </CardContent>
        </Card>
      ) : (
        <ol className="grid gap-4" aria-label="Category groups">
          {groups.map((group, groupIndex) => (
            <li key={group.id}>
              <Card className="gap-4 py-4">
                <CardContent className="grid gap-4 px-4">
                  <CategoryRow
                    {...rowProps}
                    category={group}
                    childCount={group.children.length}
                    index={groupIndex}
                    siblingCount={groups.length}
                    onMove={(category, direction) => move(category, groups, direction)}
                  />
                  {group.children.length > 0 ? (
                    <ol
                      className="grid gap-3 border-l pl-4 sm:ml-2"
                      aria-label={`Subcategories of ${group.name}`}
                    >
                      {group.children.map((child, childIndex) => (
                        <li key={child.id}>
                          <CategoryRow
                            {...rowProps}
                            category={child}
                            index={childIndex}
                            siblingCount={group.children.length}
                            onMove={(category, direction) =>
                              move(category, group.children, direction)
                            }
                          />
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="border-l pl-4 text-sm text-muted-foreground sm:ml-2">
                      No subcategories yet.
                    </p>
                  )}
                  <div className="sm:ml-2">
                    <CategoryFormDialog
                      trigger={
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Add subcategory to ${group.name}`}
                        >
                          Add subcategory
                        </Button>
                      }
                      target={{ mode: 'create', parent: group }}
                      onSaved={announce}
                    />
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
