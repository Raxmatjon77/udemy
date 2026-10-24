import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from './http/fields';
import { UNREAD_COUNT_CAP } from './http/notifications';
import {
  type NotificationApp,
  NotificationAppSchema,
  NotificationKindSchema,
} from './notifications/notification-kinds';

/**
 * Realtime contract (Phase 5 learning experience design D15–D17, §5 gateway, §7 realtime events).
 *
 * socket.io in the api process at `REALTIME_SOCKET_PATH`, WebSocket transport only. The
 * browser gets a single-use ticket from its BFF (`POST /api/realtime/ticket` → api
 * `POST /realtime/tickets`) and sends it in the handshake **`auth` payload** (never the URL).
 *
 * Server → client messages are **invalidation hints** (ids only): the client re-fetches the
 * content over REST, so no authorization or XSS-relevant rendering happens on this channel.
 * Rooms are server-assigned only: `u:{userId}:{app}` on connect, `c:{courseId}` after a
 * `subscribe` that passed the access check.
 */

export const REALTIME_SOCKET_PATH = '/realtime/socket.io';
export const REALTIME_TRANSPORTS = ['websocket'] as const;

/** Limits (D16, §9). */
export const REALTIME_LIMITS = Object.freeze({
  ticketTtlSeconds: 30,
  /** The server disconnects with `reauth_required`; the client fetches a new ticket. */
  maxConnectionSeconds: 15 * 60,
  /** Revoked-session sweep of local sockets. */
  revocationSweepSeconds: 60,
  maxSocketsPerUser: 10,
  maxCourseRoomsPerSocket: 5,
  /** Inbound messages per socket per minute, then disconnect. */
  maxInboundPerMinute: 30,
  /** `maxHttpBufferSize`. */
  maxPayloadBytes: 4096,
});

/* ----------------------------------------------------------------------------------------
 * POST /realtime/tickets -> 201 RealtimeTicket (`@AuthenticatedOnly`, every BFF; 429, 503
 * realtime_unavailable). The BFF route `POST /api/realtime/ticket` returns the same body.
 * -------------------------------------------------------------------------------------- */

/** 32 random bytes, base64url (43 characters). Never log it (pino redacts `*.ticket`). */
export const REALTIME_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const RealtimeTicketValueSchema = z
  .string()
  .regex(REALTIME_TICKET_PATTERN, 'Invalid ticket');

export const RealtimeTicketSchema = z.object({
  ticket: RealtimeTicketValueSchema,
  /** `REALTIME_PUBLIC_URL`: the socket.io origin (connect with `path: REALTIME_SOCKET_PATH`). */
  url: z.url({ protocol: /^(?:https?|wss?)$/ }).max(2048),
  expiresAt: IsoDateTimeSchema,
});
export type RealtimeTicket = z.infer<typeof RealtimeTicketSchema>;

/** socket.io handshake `auth`. */
export const RealtimeHandshakeAuthSchema = z.object({ ticket: RealtimeTicketValueSchema });
export type RealtimeHandshakeAuth = z.infer<typeof RealtimeHandshakeAuthSchema>;

/** `connect_error` `message` values of a refused handshake. */
export const REALTIME_CONNECT_ERROR_CODES = [
  'origin_not_allowed',
  'ticket_invalid',
  'session_revoked',
  'too_many_connections',
] as const;
export const RealtimeConnectErrorCodeSchema = z.enum(REALTIME_CONNECT_ERROR_CODES);
export type RealtimeConnectErrorCode = z.infer<typeof RealtimeConnectErrorCodeSchema>;

/** Why the server closed a connection (sent as `session.reauth` or the disconnect reason). */
export const REALTIME_DISCONNECT_REASONS = [
  'reauth_required',
  'session_revoked',
  'too_many_connections',
  'rate_limited',
] as const;
export const RealtimeDisconnectReasonSchema = z.enum(REALTIME_DISCONNECT_REASONS);
export type RealtimeDisconnectReason = z.infer<typeof RealtimeDisconnectReasonSchema>;

/* ----------------------------------------------------------------------------------------
 * Server → client events
 * -------------------------------------------------------------------------------------- */

export const REALTIME_SERVER_EVENTS = [
  'notification.created',
  'notification.unread',
  'qa.changed',
  'media.changed',
  'session.reauth',
] as const;
export const RealtimeServerEventSchema = z.enum(REALTIME_SERVER_EVENTS);
export type RealtimeServerEvent = z.infer<typeof RealtimeServerEventSchema>;

export const NotificationCreatedEventSchema = z.object({
  id: UuidSchema,
  kind: NotificationKindSchema,
  app: NotificationAppSchema,
});
export type NotificationCreatedEvent = z.infer<typeof NotificationCreatedEventSchema>;

/** Sent after a create and after mark-read; `count` is capped like `UnreadCount`. */
export const NotificationUnreadEventSchema = z.object({
  count: z.number().int().min(0).max(UNREAD_COUNT_CAP),
});
export type NotificationUnreadEvent = z.infer<typeof NotificationUnreadEventSchema>;

/** Course room `c:{courseId}`: refetch the Q&A list (and the question when open). */
export const QaChangedEventSchema = z.object({
  courseId: UuidSchema,
  questionId: UuidSchema,
  lectureId: UuidSchema.nullable(),
});
export type QaChangedEvent = z.infer<typeof QaChangedEventSchema>;

/** User room (instructor app): refetch the asset (transcode status in the builder). */
export const MediaChangedEventSchema = z.object({ assetId: UuidSchema });
export type MediaChangedEvent = z.infer<typeof MediaChangedEventSchema>;

/** Get a new ticket and reconnect (the 15 min cap is near or reached). */
export const SessionReauthEventSchema = z.object({}).strict();
export type SessionReauthEvent = z.infer<typeof SessionReauthEventSchema>;

export const REALTIME_SERVER_EVENT_SCHEMAS = Object.freeze({
  'notification.created': NotificationCreatedEventSchema,
  'notification.unread': NotificationUnreadEventSchema,
  'qa.changed': QaChangedEventSchema,
  'media.changed': MediaChangedEventSchema,
  'session.reauth': SessionReauthEventSchema,
} satisfies Record<RealtimeServerEvent, z.ZodType>);

export type RealtimeServerEventPayload<E extends RealtimeServerEvent> = z.output<
  (typeof REALTIME_SERVER_EVENT_SCHEMAS)[E]
>;

/** socket.io `ServerToClientEvents` typing (`Server<ClientToServer, ServerToClient>`). */
export type RealtimeServerToClientEvents = {
  [E in RealtimeServerEvent]: (payload: RealtimeServerEventPayload<E>) => void;
};

export function parseRealtimeServerEvent<E extends RealtimeServerEvent>(
  event: E,
  payload: unknown,
): RealtimeServerEventPayload<E> {
  return REALTIME_SERVER_EVENT_SCHEMAS[event].parse(payload) as RealtimeServerEventPayload<E>;
}

/* ----------------------------------------------------------------------------------------
 * Client → server messages (with acks)
 * -------------------------------------------------------------------------------------- */

export const REALTIME_CLIENT_EVENTS = ['subscribe', 'unsubscribe'] as const;
export const RealtimeClientEventSchema = z.enum(REALTIME_CLIENT_EVENTS);
export type RealtimeClientEvent = z.infer<typeof RealtimeClientEventSchema>;

/** Join or leave the course room; granted after `hasAccess` or the owner check. */
export const CourseRoomRequestSchema = z.object({ courseId: UuidSchema });
export type CourseRoomRequest = z.infer<typeof CourseRoomRequestSchema>;

export const REALTIME_SUBSCRIBE_ERRORS = ['forbidden', 'too_many_rooms', 'invalid'] as const;
export const RealtimeSubscribeErrorSchema = z.enum(REALTIME_SUBSCRIBE_ERRORS);
export type RealtimeSubscribeError = z.infer<typeof RealtimeSubscribeErrorSchema>;

export const CourseRoomAckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: RealtimeSubscribeErrorSchema }),
]);
export type CourseRoomAck = z.infer<typeof CourseRoomAckSchema>;

/** socket.io `ClientToServerEvents` typing. */
export interface RealtimeClientToServerEvents {
  subscribe: (request: CourseRoomRequest, ack: (result: CourseRoomAck) => void) => void;
  unsubscribe: (request: CourseRoomRequest, ack: (result: CourseRoomAck) => void) => void;
}

/* ----------------------------------------------------------------------------------------
 * Room names: shared by the api gateway and the worker's Redis emitter, so they must match.
 * -------------------------------------------------------------------------------------- */

export function realtimeUserRoom(userId: string, app: NotificationApp): string {
  return `u:${userId}:${app}`;
}

export function realtimeCourseRoom(courseId: string): string {
  return `c:${courseId}`;
}
