import {
  ENROLLMENT_ENROLLMENT_AGGREGATE,
  EnrollmentRevoked,
  type EventEnvelope,
  realtimeCourseRoom,
  realtimeUserRoom,
} from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import {
  EventHandler,
  type EventHandlerContract,
  type HandlerContext,
  parseEvent,
} from '../../messaging';
import { RealtimeEmitter } from '../../shared/realtime';

/**
 * `notifications.room-revoker` (design D17): `EnrollmentRevoked` -> after commit, every socket of
 * the learner's student room `u:{userId}:STUDENT` leaves the course room `c:{courseId}` on every
 * api replica (`RealtimeEmitter.socketsLeave`, a REMOTE_LEAVE over the Redis adapter). The
 * gateway re-checks `hasAccess` on every new `subscribe`, so a missed leave (Redis blip) only
 * leaks "something changed" id hints until the 15 min reconnect. Writes nothing in the database
 * besides the processed-event claim.
 */
@EventHandler(ENROLLMENT_ENROLLMENT_AGGREGATE, EnrollmentRevoked.type, {
  consumerName: 'notifications.room-revoker',
})
export class RoomRevokerHandler implements EventHandlerContract {
  constructor(private readonly realtime: RealtimeEmitter) {}

  async handle(
    envelope: EventEnvelope,
    _trx: Transaction<DB>,
    context: HandlerContext,
  ): Promise<void> {
    const event = parseEvent(EnrollmentRevoked, envelope);
    const userRoom = realtimeUserRoom(event.userId, 'STUDENT');
    const courseRoom = realtimeCourseRoom(event.courseId);
    context.afterCommit(() => this.realtime.socketsLeave(userRoom, [courseRoom]));
  }
}
