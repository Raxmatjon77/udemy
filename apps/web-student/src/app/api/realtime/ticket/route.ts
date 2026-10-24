import { realtimeTicket } from '@/lib/auth/handlers';

/**
 * `POST /api/realtime/ticket` (Phase 5 D16): a single-use socket.io ticket for the handshake
 * `auth` payload, from the API through `createRealtimeTicketHandler` (@udemy/web-auth): Origin
 * check, the session's access token (refreshed when needed), the body re-validated, `no-store`.
 */
export { realtimeTicket as POST };
