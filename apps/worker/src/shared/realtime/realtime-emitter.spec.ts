import { realtimeCourseRoom, realtimeUserRoom } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { RedisClient } from '../redis';
import { RealtimeEmitter, RealtimePushError } from './realtime-emitter';

const USER = '01900000-0000-7000-8000-0000000000a1';
const COURSE = '01900000-0000-7000-8000-0000000000c1';

function setup(failing = false) {
  const published: { channel: string; message: string | Buffer }[] = [];
  const redis = {
    publish: (channel: string, message: string | Buffer): Promise<number> => {
      published.push({ channel, message });
      return failing ? Promise.reject(new Error("Stream isn't writeable")) : Promise.resolve(1);
    },
  };
  return { published, emitter: new RealtimeEmitter(redis as unknown as RedisClient) };
}

/*
 * The wire format the api's socket.io Redis adapter (8.3.0) listens to: broadcasts on
 * `socket.io#/#<room>#` (msgpack), room requests on `socket.io-request#/#` (JSON). The
 * round trip against a real adapter is in the api's realtime-redis.integration.spec.ts.
 */
describe('RealtimeEmitter (worker)', () => {
  it('publishes a validated hint on the user room channel', async () => {
    const { published, emitter } = setup();
    await emitter.emit(realtimeUserRoom(USER, 'STUDENT'), 'notification.unread', { count: 1 });
    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe(`socket.io#/#u:${USER}:STUDENT#`);
    expect(Buffer.isBuffer(published[0]?.message)).toBe(true);
  });

  it('refuses a payload outside the contract before publishing', async () => {
    const { published, emitter } = setup();
    await expect(
      emitter.emit('u:x:STUDENT', 'notification.unread', { count: -1 }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(published).toHaveLength(0);
  });

  it('socketsLeave publishes a REMOTE_LEAVE request scoped to the user room', async () => {
    const { published, emitter } = setup();
    const userRoom = realtimeUserRoom(USER, 'STUDENT');
    await emitter.socketsLeave(userRoom, [realtimeCourseRoom(COURSE)]);
    expect(published).toEqual([
      {
        channel: 'socket.io-request#/#',
        message: JSON.stringify({
          type: 3,
          opts: { rooms: [userRoom], except: [] },
          rooms: [`c:${COURSE}`],
        }),
      },
    ]);
  });

  it('rejects with RealtimePushError when Redis refuses the publish', async () => {
    const { emitter } = setup(true);
    await expect(emitter.emit('c:1', 'media.changed', { assetId: COURSE })).rejects.toBeInstanceOf(
      RealtimePushError,
    );
  });
});
