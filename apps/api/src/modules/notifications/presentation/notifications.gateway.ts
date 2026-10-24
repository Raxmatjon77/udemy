import { Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage } from '@nestjs/websockets';
import {
  type CourseRoomAck,
  CourseRoomRequestSchema,
  REALTIME_LIMITS,
  realtimeCourseRoom,
} from '@udemy/contracts';
import type { Socket } from 'socket.io';
import { AuthenticatedOnly } from '../../../shared/auth';
import { getRealtimeIdentity, RealtimeGateway } from '../../../shared/realtime';
import { AuthorizeCourseRoomQuery } from '../application/use-cases/authorize-course-room.query';

const COURSE_ROOM_PREFIX = realtimeCourseRoom('');
const OK: CourseRoomAck = { ok: true };
const FORBIDDEN: CourseRoomAck = { ok: false, error: 'forbidden' };
const TOO_MANY_ROOMS: CourseRoomAck = { ok: false, error: 'too_many_rooms' };
const INVALID: CourseRoomAck = { ok: false, error: 'invalid' };

function courseRoomCount(socket: Socket): number {
  let count = 0;
  for (const room of socket.rooms) if (room.startsWith(COURSE_ROOM_PREFIX)) count += 1;
  return count;
}

/**
 * The api's socket.io gateway (design D15–D17, §5 gateway). The connection itself, i.e. ticket,
 * Origin, revoked session, 10 sockets per user, the user room `u:{userId}:{APP}`, the 15 min
 * cap with `session.reauth`, 30 inbound messages per minute, the 4 KB payload limit and the 60 s
 * revoked-session sweep, is enforced by `RedisIoAdapter` for every gateway. This class adds the
 * only client → server messages:
 *
 * - `subscribe {courseId}` → join `c:{courseId}` (Q&A hints in the player) after the access
 *   check of `AuthorizeCourseRoomQuery` (learner or owner; admins with `course:read:any`), at
 *   most `maxCourseRoomsPerSocket` (5) rooms per socket;
 * - `unsubscribe {courseId}` → leave it (always allowed, idempotent).
 *
 * Both answer through the ack: `{ ok: true }` or `{ ok: false, error }` with `forbidden`,
 * `too_many_rooms` or `invalid`. A failed access check (e.g. the database is down) is
 * `forbidden`: rooms fail closed. Room names are never taken from the client.
 */
@RealtimeGateway()
export class NotificationsGateway {
  private readonly logger = new Logger(NotificationsGateway.name);

  constructor(private readonly courseRooms: AuthorizeCourseRoomQuery) {}

  @SubscribeMessage('subscribe')
  @AuthenticatedOnly()
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<CourseRoomAck> {
    const identity = getRealtimeIdentity(socket);
    if (identity === undefined) return FORBIDDEN;
    const request = CourseRoomRequestSchema.safeParse(body);
    if (!request.success) return INVALID;
    if (socket.rooms.has(realtimeCourseRoom(request.data.courseId.toLowerCase()))) return OK;
    if (courseRoomCount(socket) >= REALTIME_LIMITS.maxCourseRoomsPerSocket) return TOO_MANY_ROOMS;

    let courseId: string | null;
    try {
      courseId = await this.courseRooms.execute(identity.principal, request.data.courseId);
    } catch (error) {
      this.logger.warn(
        { err: error, userId: identity.principal.userId },
        'Course room access check failed; refusing the subscription',
      );
      return FORBIDDEN;
    }
    if (courseId === null || !socket.connected) return FORBIDDEN;

    // Re-checked after the await, then joined synchronously: parallel subscribes cannot pass
    // the cap together.
    const room = realtimeCourseRoom(courseId);
    if (socket.rooms.has(room)) return OK;
    if (courseRoomCount(socket) >= REALTIME_LIMITS.maxCourseRoomsPerSocket) return TOO_MANY_ROOMS;
    await socket.join(room);
    return OK;
  }

  @SubscribeMessage('unsubscribe')
  @AuthenticatedOnly()
  async unsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<CourseRoomAck> {
    const request = CourseRoomRequestSchema.safeParse(body);
    if (!request.success) return INVALID;
    await socket.leave(realtimeCourseRoom(request.data.courseId.toLowerCase()));
    return OK;
  }
}
