/**
 * `@udemy/web-realtime`: the browser side of the Phase 5 realtime layer (design D15–D17, §10):
 * a socket.io client with a fresh BFF ticket per connection, plus React bindings that turn
 * server hints into TanStack Query invalidations, with a polling fallback.
 */
export {
  DEFAULT_REALTIME_TICKET_PATH,
  fetchRealtimeTicket,
  RealtimeClient,
  RealtimeTicketError,
} from './client';
export type {
  RealtimeClientOptions,
  RealtimeSocket,
  RealtimeSocketFactory,
  RealtimeSocketOptions,
  RealtimeStatus,
} from './client';
export { REALTIME_QUERY_ROOTS, realtimeInvalidationKeys } from './invalidation';
export {
  RealtimeProvider,
  useCourseRoom,
  useLiveRefetchInterval,
  useRealtimeClient,
  useRealtimeEvent,
  useRealtimeStatus,
} from './react';
