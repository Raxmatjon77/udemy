'use client';

import { QueryClientContext } from '@tanstack/react-query';
import {
  REALTIME_SERVER_EVENTS,
  type RealtimeServerEvent,
  type RealtimeServerEventPayload,
} from '@udemy/contracts';
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { RealtimeClient, type RealtimeStatus } from './client';
import { realtimeInvalidationKeys } from './invalidation';

const RealtimeContext = createContext<RealtimeClient | null>(null);

/**
 * Provides the realtime client to the app. `enabled: false` (no `REALTIME_PUBLIC_URL`) means no
 * socket at all: `useRealtimeStatus()` is `'disabled'` and `useLiveRefetchInterval` polls.
 * With `invalidate` (default), server hints invalidate the matching TanStack Query keys of the
 * surrounding `QueryClientProvider` (see `realtimeInvalidationKeys`).
 */
export function RealtimeProvider({
  enabled,
  client: given,
  invalidate = true,
  children,
}: {
  enabled: boolean;
  client?: RealtimeClient;
  invalidate?: boolean;
  children: ReactNode;
}) {
  const client = useMemo(
    () => (enabled ? (given ?? new RealtimeClient()) : null),
    [enabled, given],
  );
  const queryClient = useContext(QueryClientContext);

  useEffect(() => {
    if (!client) return;
    client.start();
    return () => client.stop();
  }, [client]);

  useEffect(() => {
    if (!client || !invalidate || !queryClient) return;
    const offs = REALTIME_SERVER_EVENTS.map((event) =>
      client.on(event, (payload) => {
        for (const queryKey of realtimeInvalidationKeys(event, payload)) {
          void queryClient.invalidateQueries({ queryKey });
        }
      }),
    );
    return () => {
      for (const off of offs) off();
    };
  }, [client, invalidate, queryClient]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeClient(): RealtimeClient | null {
  return useContext(RealtimeContext);
}

const noop = () => () => {};

/** The socket state; `'disabled'` outside a provider or when realtime is off. */
export function useRealtimeStatus(): RealtimeStatus {
  const client = useRealtimeClient();
  return useSyncExternalStore(
    client ? (listener) => client.onStatus(listener) : noop,
    () => client?.status ?? 'disabled',
    () => 'disabled',
  );
}

/** Calls the latest `handler` for every (validated) `event`. */
export function useRealtimeEvent<E extends RealtimeServerEvent>(
  event: E,
  handler: (payload: RealtimeServerEventPayload<E>) => void,
): void {
  const client = useRealtimeClient();
  const onEvent = useEffectEvent((payload: RealtimeServerEventPayload<E>) => handler(payload));
  useEffect(() => {
    if (!client) return;
    return client.on(event, (payload) => onEvent(payload));
  }, [client, event]);
}

/** Joins the course room `c:{courseId}` while mounted (Q&A hints in the player). */
export function useCourseRoom(courseId: string | null): void {
  const client = useRealtimeClient();
  useEffect(() => {
    if (!client || !courseId) return;
    return client.subscribeCourse(courseId);
  }, [client, courseId]);
}

/** Polling fallback: `false` while the socket is connected, else `ms` (a `refetchInterval`). */
export function useLiveRefetchInterval(ms: number): number | false {
  return useRealtimeStatus() === 'connected' ? false : ms;
}
