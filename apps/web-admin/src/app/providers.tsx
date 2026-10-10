'use client';

import {
  QueryClient,
  QueryClientProvider,
  defaultShouldDehydrateQuery,
  isServer,
  useQueryClient,
} from '@tanstack/react-query';
import { onLogoutBroadcast } from '@udemy/web-auth/client';
import { useEffect, type ReactNode } from 'react';

import { isApiError } from '@/lib/problem';

/*
 * Client-side providers for the whole app: TanStack Query (all data goes through the BFF's
 * /api/proxy, see src/lib/api.ts) and the cross-tab logout listener.
 */

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR, avoid refetching immediately on the client right after hydration.
        staleTime: 60 * 1000,
        refetchOnWindowFocus: false,
        // A 4xx will not get better by retrying; network errors and 5xx get one retry.
        retry: (failureCount, error) =>
          failureCount < 1 && !(isApiError(error) && error.status < 500),
      },
      mutations: { retry: false },
      dehydrate: {
        // Also hand pending queries to the client so server-started prefetches can stream in.
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * Server: a fresh client per request (never share cache between users).
 * Browser: one singleton, so a suspending render can't throw the cache away.
 */
function getQueryClient(): QueryClient {
  if (isServer) {
    return makeQueryClient();
  }
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

/**
 * Another tab logged out (BroadcastChannel('auth')): drop every cached user's data and reload.
 * proxy.ts then sends protected pages to the login page, and public pages render signed out.
 */
function LogoutBroadcastListener() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      onLogoutBroadcast(() => {
        queryClient.clear();
        window.location.reload();
      }),
    [queryClient],
  );
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <LogoutBroadcastListener />
      {children}
    </QueryClientProvider>
  );
}
