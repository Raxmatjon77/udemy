'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  ACCOUNT_STATUSES,
  ASSIGNABLE_ROLES,
  AdminUserPageSchema,
  type AdminUsersQuery,
} from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import { Card, CardContent } from '@udemy/ui/components/card';
import { FormField } from '@udemy/ui/components/form-field';
import { Input } from '@udemy/ui/components/input';
import { NativeSelect } from '@udemy/ui/components/native-select';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { Spinner } from '@udemy/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';

import { QueryError } from '@/components/query-error';
import { api, queryString } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { ACCOUNT_STATUS_LABEL, ROLE_LABEL } from '@/lib/labels';
import { queryKeys } from '@/lib/queries';
import { formResolver } from '@/lib/zod-messages';

export type UserFilters = Pick<AdminUsersQuery, 'q' | 'status' | 'role'>;

const PAGE_SIZE = 20;

/** The search form; "" means "any" for the selects. `q` follows the API rule (≥ 3 characters). */
const SearchFormSchema = z.object({
  q: z
    .string()
    .trim()
    .max(254)
    .refine((value) => value === '' || value.length >= 3, {
      message: 'Enter at least 3 characters, or leave it empty.',
    }),
  status: z.enum(['', ...ACCOUNT_STATUSES]),
  role: z.enum(['', ...ASSIGNABLE_ROLES]),
});

function SearchForm({ filters }: { filters: UserFilters }) {
  const router = useRouter();
  const defaultValues: z.input<typeof SearchFormSchema> = {
    q: filters.q ?? '',
    status: filters.status ?? '',
    role: filters.role ?? '',
  };
  const { register, handleSubmit, formState } = useForm({
    resolver: formResolver(SearchFormSchema),
    defaultValues,
  });

  return (
    <form
      role="search"
      noValidate
      onSubmit={handleSubmit((values) => router.push(`/users${queryString(values)}`))}
      className="grid items-start gap-4 sm:grid-cols-[1fr_10rem_10rem_auto]"
    >
      <FormField id="q" label="Name or email" error={formState.errors.q?.message}>
        {(field) => (
          <Input {...field} type="search" placeholder="jane@example.com" {...register('q')} />
        )}
      </FormField>
      <FormField id="status" label="Status">
        {(field) => (
          <NativeSelect {...field} {...register('status')}>
            <option value="">Any status</option>
            {ACCOUNT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {ACCOUNT_STATUS_LABEL[status]}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField id="role" label="Role">
        {(field) => (
          <NativeSelect {...field} {...register('role')}>
            <option value="">Any role</option>
            {ASSIGNABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <Button type="submit" className="sm:mt-[1.375rem]">
        Search
      </Button>
    </form>
  );
}

function Results({ filters }: { filters: UserFilters }) {
  const users = useInfiniteQuery({
    queryKey: queryKeys.userSearch(filters),
    queryFn: ({ pageParam }) =>
      api(`/admin/users${queryString({ ...filters, cursor: pageParam, limit: PAGE_SIZE })}`, {
        schema: AdminUserPageSchema,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  if (users.isPending) {
    return (
      <Card aria-busy="true" aria-label="Loading users">
        <CardContent className="grid gap-3">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }
  if (!users.data) {
    return <QueryError error={users.error} onRetry={() => void users.refetch()} />;
  }

  const items = users.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No users match these filters.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      <Card className="py-2">
        <CardContent className="px-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="grid gap-0.5">
                      <Link
                        href={`/users/${user.id}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {user.displayName}
                      </Link>
                      <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        {user.email}
                        {!user.emailVerified ? <Badge variant="outline">Unverified</Badge> : null}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {user.roles.map((role) => (
                        <Badge key={role} variant={role === 'STUDENT' ? 'outline' : 'secondary'}>
                          {ROLE_LABEL[role]}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.status === 'BANNED' ? 'destructive' : 'outline'}>
                      {ACCOUNT_STATUS_LABEL[user.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <time dateTime={user.createdAt}>{formatDate(user.createdAt)}</time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex items-center justify-between gap-4">
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Showing {items.length} user{items.length === 1 ? '' : 's'}
          {users.hasNextPage ? '' : ' (all)'}
        </p>
        {users.hasNextPage ? (
          <Button
            variant="outline"
            onClick={() => void users.fetchNextPage()}
            disabled={users.isFetchingNextPage}
          >
            {users.isFetchingNextPage ? <Spinner /> : null}
            {users.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        ) : null}
      </div>
      {users.isFetchNextPageError ? (
        <QueryError error={users.error} onRetry={() => void users.fetchNextPage()} />
      ) : null}
    </div>
  );
}

export function UsersSearch({ filters }: { filters: UserFilters }) {
  return (
    <div className="grid gap-6">
      <SearchForm filters={filters} />
      <Results filters={filters} />
    </div>
  );
}
