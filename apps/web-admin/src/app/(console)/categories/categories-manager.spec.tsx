// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AdminCategoryTreeResponse } from '@udemy/contracts';

import { json, mockApi, noContent, problem, type MockHandler } from '@/test/api-mock';
import {
  category,
  categoryTree,
  GROUP_DESIGN,
  GROUP_DEV,
  LEAF_DATA,
  LEAF_MOBILE,
  LEAF_UX,
  LEAF_WEB,
  uuid,
} from '@/test/fixtures';
import { renderWithClient } from '@/test/render';

import { CategoriesManager } from './categories-manager';

/** A tiny server: the tree lives here, PUT /order applies to it unless a handler overrides. */
function setup(overrides: Record<string, MockHandler> = {}) {
  let tree: AdminCategoryTreeResponse = categoryTree();
  const api = mockApi({
    'GET /admin/categories': () => json(tree),
    'PUT /admin/categories/order': ({ body }) => {
      const { parentId, orderedIds } = body as { parentId: string | null; orderedIds: string[] };
      const reorder = <T extends { id: string }>(items: T[]) =>
        orderedIds.map((id, position) => ({ ...items.find((i) => i.id === id)!, position }));
      tree =
        parentId === null
          ? { items: reorder(tree.items) }
          : {
              items: tree.items.map((g) =>
                g.id === parentId ? { ...g, children: reorder(g.children) } : g,
              ),
            };
      return noContent();
    },
    ...overrides,
  });
  const rendered = renderWithClient(<CategoriesManager />);
  return { api, ...rendered, setTree: (next: AdminCategoryTreeResponse) => (tree = next) };
}

const names = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-testid^="category-"] span span')?.textContent);

const subcategories = (group: string) =>
  screen.getByRole('list', { name: `Subcategories of ${group}` });

describe('<CategoriesManager>', () => {
  it('renders the two-level tree in order with status and counts', async () => {
    setup();
    const groups = await screen.findByRole('list', { name: 'Category groups' });
    expect(
      within(groups)
        .getAllByRole('listitem')
        .filter((li) => li.parentElement === groups)
        .map((li) => li.querySelector('span span')?.textContent),
    ).toEqual(['Development', 'Design']);
    expect(names(subcategories('Development'))).toEqual([
      'Web development',
      'Mobile development',
      'Data science',
    ]);
    const data = screen.getByTestId(`category-${LEAF_DATA}`);
    expect(within(data).getByText('Inactive')).toBeTruthy();
    expect(within(data).getByRole('button', { name: 'Activate Data science' })).toBeTruthy();
    expect(screen.getByTestId(`category-${LEAF_WEB}`).textContent).toContain('12 courses');
    expect(screen.getByTestId(`category-${GROUP_DEV}`).textContent).toContain('3 subcategories');
    // Ends of each sibling list cannot move further.
    expect(
      (screen.getByRole('button', { name: 'Move Web development up' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Move Design down' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('reorders within siblings with the keyboard, keeping focus on the moved item', async () => {
    const { api, user } = setup();
    const down = await screen.findByRole('button', { name: 'Move Web development down' });
    down.focus();
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(names(subcategories('Development'))).toEqual([
        'Mobile development',
        'Web development',
        'Data science',
      ]),
    );
    expect(api.callsTo('PUT', /order$/).map((c) => c.body)).toEqual([
      { parentId: GROUP_DEV, orderedIds: [LEAF_MOBILE, LEAF_WEB, LEAF_DATA] },
    ]);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Move Web development down' }),
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Moved “Web development” to position 2 of 3.',
    );

    // Pressing again reaches the end: focus moves to the "up" button, which stays enabled.
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Move Web development up' }),
      ),
    );
    expect(api.callsTo('PUT', /order$/)[1]?.body).toEqual({
      parentId: GROUP_DEV,
      orderedIds: [LEAF_MOBILE, LEAF_DATA, LEAF_WEB],
    });
  });

  it('reorders the groups with a null parent', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Move Design up' }));
    await waitFor(() =>
      expect(api.callsTo('PUT', /order$/).map((c) => c.body)).toEqual([
        { parentId: null, orderedIds: [GROUP_DESIGN, GROUP_DEV] },
      ]),
    );
  });

  it('rolls back a refused reorder and explains order_mismatch', async () => {
    const { api, user } = setup({
      'PUT /admin/categories/order': () => problem(409, 'order_mismatch'),
    });
    await user.click(await screen.findByRole('button', { name: 'Move Mobile development up' }));
    expect(await screen.findByText(/The list changed in the meantime/)).toBeTruthy();
    expect(names(subcategories('Development'))).toEqual([
      'Web development',
      'Mobile development',
      'Data science',
    ]);
    await waitFor(() => expect(api.callsTo('GET', /categories$/)).toHaveLength(2));
  });

  it('creates a group and a subcategory', async () => {
    const created: unknown[] = [];
    const { user } = setup({
      'POST /admin/categories': ({ body }) => {
        created.push(body);
        const { name, parentId } = body as { name: string; parentId?: string };
        return json(
          category({ id: uuid(77), name, ...(parentId ? { parentId, depth: 2 } : {}) }),
          201,
        );
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Add group' }));
    let dialog = screen.getByRole('dialog', { name: 'Add a group' });
    await user.type(within(dialog).getByLabelText('Name'), 'Business');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Created “Business”.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Add subcategory to Design' }));
    dialog = screen.getByRole('dialog', { name: 'Add a subcategory to “Design”' });
    await user.type(within(dialog).getByLabelText('Name'), 'Graphic design');
    await user.type(within(dialog).getByLabelText(/Slug/), 'Graphic-Design');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(created).toEqual([
      { name: 'Business' },
      { name: 'Graphic design', slug: 'graphic-design', parentId: GROUP_DESIGN },
    ]);
  });

  it('shows slug_taken under the slug field', async () => {
    const { user } = setup({ 'POST /admin/categories': () => problem(409, 'slug_taken') });
    await user.click(await screen.findByRole('button', { name: 'Add group' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Development');
    await user.type(within(dialog).getByLabelText(/Slug/), 'development');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText('Another category already uses this slug.'),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText(/Slug/).getAttribute('aria-invalid')).toBe('true');
  });

  it('validates the slug before sending', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: 'Add group' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Music');
    await user.type(within(dialog).getByLabelText(/Slug/), 'music--theory');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText(/single hyphens only/)).toBeTruthy();
    expect(api.callsTo('POST', /categories$/)).toHaveLength(0);
  });

  it('renames a subcategory and moves it to another group, sending only what changed', async () => {
    const patches: unknown[] = [];
    const { user } = setup({
      'PATCH /admin/categories/:id': ({ body }) => {
        patches.push(body);
        return json(
          category({ id: LEAF_UX, name: 'UX & UI design', parentId: GROUP_DEV, depth: 2 }),
        );
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Edit UX design' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit “UX design”' });
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'UX & UI design');
    await user.selectOptions(within(dialog).getByLabelText('Group'), GROUP_DEV);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved “UX & UI design”.')).toBeTruthy();
    expect(patches).toEqual([{ name: 'UX & UI design', parentId: GROUP_DEV }]);
  });

  it('deactivates and activates', async () => {
    const patches: unknown[] = [];
    const { user } = setup({
      'PATCH /admin/categories/:id': ({ body, path }) => {
        patches.push([path, body]);
        const { isActive } = body as { isActive: boolean };
        return json(category({ id: LEAF_WEB, name: 'Web development', isActive }));
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Deactivate Web development' }));
    expect(
      await screen.findByText('“Web development” was deactivated and is hidden from the catalog.'),
    ).toBeTruthy();
    expect(patches).toEqual([[`/admin/categories/${LEAF_WEB}`, { isActive: false }]]);
  });

  it('explains category_in_use on delete and suggests deactivating', async () => {
    const { user } = setup({
      'DELETE /admin/categories/:id': () => problem(409, 'category_in_use'),
    });
    await user.click(await screen.findByRole('button', { name: 'Delete Web development' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete “Web development”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete category' }));
    const message = await within(dialog).findByText(/cannot be deleted/);
    expect(message.textContent).toContain('“Web development” is used by 12 courses');
    expect(message.textContent).toContain('Deactivate it instead');
  });

  it('explains category_in_use for a group with subcategories', async () => {
    const { user } = setup({
      'DELETE /admin/categories/:id': () => problem(409, 'category_in_use'),
    });
    await user.click(await screen.findByRole('button', { name: 'Delete Development' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete category' }));
    expect((await within(dialog).findByText(/cannot be deleted/)).textContent).toContain(
      '“Development” has 3 subcategories',
    );
  });

  it('deletes an unused category', async () => {
    const { api, user, setTree } = setup({
      'DELETE /admin/categories/:id': () => {
        const tree = categoryTree();
        setTree({
          items: tree.items.map((g) => (g.id === GROUP_DESIGN ? { ...g, children: [] } : g)),
        });
        return noContent();
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Delete UX design' }));
    await user.click(screen.getByRole('button', { name: 'Delete category' }));
    expect(await screen.findByText('Deleted “UX design”.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId(`category-${LEAF_UX}`)).toBeNull());
    expect(api.callsTo('DELETE', /categories/).map((c) => c.path)).toEqual([
      `/admin/categories/${LEAF_UX}`,
    ]);
  });
});
