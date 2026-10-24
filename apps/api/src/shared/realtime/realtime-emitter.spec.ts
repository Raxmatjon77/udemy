import { realtimeCourseRoom, realtimeUserRoom } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { type RedisClient, RedisUnavailableError } from '../redis';
import { RealtimeEmitter } from './realtime-emitter';

const COURSE = '01900000-0000-7000-8000-0000000000c1';
const QUESTION = '01900000-0000-7000-8000-0000000000d1';
const USER = '01900000-0000-7000-8000-0000000000a1';

function setup(failing = false) {
  const published: { channel: string; message: string | Buffer }[] = [];
  const redis = {
    publish: (channel: string, message: string | Buffer): Promise<number> => {
      published.push({ channel, message });
      return failing ? Promise.reject(new Error('closed')) : Promise.resolve(1);
    },
  };
  return { published, emitter: new RealtimeEmitter(redis as unknown as RedisClient) };
}

/*
 * The wire format the socket.io Redis adapter (8.3.0) subscribes to: broadcasts on
 * `socket.io#/#<room>#` (msgpack), room requests on `socket.io-request#/#` (JSON).
 */
describe('RealtimeEmitter (api)', () => {
  it('publishes a validated hint on the room channel and waits for Redis', async () => {
    const { published, emitter } = setup();
    await emitter.emit(realtimeCourseRoom(COURSE), 'qa.changed', {
      courseId: COURSE,
      questionId: QUESTION,
      lectureId: null,
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe(`socket.io#/#c:${COURSE}#`);
    expect(Buffer.isBuffer(published[0]?.message)).toBe(true);
  });

  it('refuses a payload outside the contract before publishing', async () => {
    const { published, emitter } = setup();
    await expect(
      emitter.emit('c:x', 'qa.changed', { courseId: 'nope' } as never),
    ).rejects.toBeInstanceOf(ZodError);
    expect(published).toHaveLength(0);
  });

  it('socketsLeave sends a REMOTE_LEAVE request every replica applies locally', async () => {
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

  it('rejects with RedisUnavailableError when the publish fails', async () => {
    const { emitter } = setup(true);
    await expect(emitter.socketsLeave('u:1:STUDENT', ['c:1'])).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
  });
});
