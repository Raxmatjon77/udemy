import type { Metadata } from 'next';
import { AdminUsersQuerySchema } from '@udemy/contracts';

import { UsersSearch, type UserFilters } from './users-search';

export const metadata: Metadata = { title: 'Users' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function UsersPage({ searchParams }: PageProps<'/users'>) {
  const params = await searchParams;
  const { shape } = AdminUsersQuerySchema;
  // Each filter is validated on its own: one bad value (e.g. a 2-letter q) does not drop the rest.
  const q = shape.q.safeParse(first(params.q));
  const status = shape.status.safeParse(first(params.status));
  const role = shape.role.safeParse(first(params.role));
  const filters: UserFilters = {
    q: q.success ? q.data : undefined,
    status: status.success ? status.data : undefined,
    role: role.success ? role.data : undefined,
  };

  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-muted-foreground">
          Search accounts by name or email, newest first.
        </p>
      </div>
      <UsersSearch key={JSON.stringify(filters)} filters={filters} />
    </>
  );
}
