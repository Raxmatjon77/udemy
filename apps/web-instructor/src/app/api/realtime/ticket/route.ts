import { realtimeTicket } from '@/lib/auth/handlers';

/**
 * `POST /api/realtime/ticket` → `POST /api/v1/realtime/tickets` with the session (Phase 5 D16):
 * a single-use, 30 s socket.io ticket for the handshake `auth` payload. Origin-checked; see
 * `createRealtimeTicketHandler` in @udemy/web-auth.
 */
export { realtimeTicket as POST };
