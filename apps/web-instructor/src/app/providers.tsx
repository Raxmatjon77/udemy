'use client';

import {
  QueryClient,
  QueryClientProvider,
  defaultShouldDehydrateQuery,
  isServer,
} from '@tanstack/react-query';
import type { ReactNode } from 'react';

/*
 * Client-side providers for the whole app.
 *
 * Roadmap:
 * - Phase 1: an auth/session provider. The refresh token lives in an httpOnly cookie and is
 *   exchanged through a BFF route handler (src/app/api/auth/...); the access token stays in memory.
 * - Once apps/api exposes OpenAPI, the generated @udemy/api-client (orval + TanStack Query
 *   hooks) will use this QueryClient.
 */

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR, avoid refetching immediately on the client right after hydration.
        staleTime: 60 * 1000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
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

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
