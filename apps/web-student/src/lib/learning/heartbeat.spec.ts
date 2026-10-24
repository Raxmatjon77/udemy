import type { ProgressAck, RecordHeartbeatRequest } from '@udemy/contracts';
import { describe, expect, it, vi } from 'vitest';

import { HeartbeatSender, toHeartbeatRanges } from './heartbeat';

const ACK: ProgressAck = { lectureCompleted: false, courseCompleted: false, coursePct: 0 };

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function setup(respond: (body: RecordHeartbeatRequest) => Promise<ProgressAck> = async () => ACK) {
  const sent: { body: RecordHeartbeatRequest; keepalive: boolean }[] = [];
  const onAck = vi.fn();
  const onStopped = vi.fn();
  const sender = new HeartbeatSender({
    durationSeconds: 300,
    send: (body, { keepalive }) => {
      sent.push({ body, keepalive });
      return respond(body);
    },
    statusOf: (error) => (error instanceof HttpError ? error.status : null),
    onAck,
    onStopped,
  });
  return { sender, sent, onAck, onStopped };
}

describe('toHeartbeatRanges', () => {
  it('floors from, ceils to, clamps to the duration and merges', () => {
    expect(
      toHeartbeatRanges(
        [
          { from: 10.7, to: 20.2 },
          { from: 0.4, to: 5.1 },
          { from: 20.5, to: 30 },
          { from: 290.2, to: 312 },
          { from: 50, to: 50.0 },
        ],
        300,
      ),
    ).toEqual([
      { from: 0, to: 6 },
      { from: 10, to: 30 },
      { from: 290, to: 300 },
    ]);
  });

  it('keeps the newest 32 ranges', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ from: i * 5, to: i * 5 + 1 }));
    const out = toHeartbeatRanges(many, 300);
    expect(out).toHaveLength(32);
    expect(out[0]).toEqual({ from: 40, to: 41 });
    expect(out.at(-1)).toEqual({ from: 195, to: 196 });
  });
});

describe('HeartbeatSender', () => {
  it('sends the buffered ranges and the whole-second position, then reports the ack', async () => {
    const { sender, sent, onAck } = setup();
    sender.record([{ from: 0, to: 14.6 }], 14.6);
    await sender.flush();
    expect(sent).toEqual([
      { body: { positionSeconds: 14, ranges: [{ from: 0, to: 15 }] }, keepalive: false },
    ]);
    expect(onAck).toHaveBeenCalledWith(ACK);
  });

  it('sends nothing without news (same position, no ranges)', async () => {
    const { sender, sent } = setup();
    sender.record([], 14);
    await sender.flush();
    sender.record([], 14.9);
    await sender.flush();
    expect(sent).toHaveLength(1);
    sender.record([], 15);
    await sender.flush();
    expect(sent).toHaveLength(2);
  });

  it('one request at a time: a flush during a request sends again right after it', async () => {
    let release!: () => void;
    const { sender, sent } = setup(
      () => new Promise<ProgressAck>((resolve) => (release = () => resolve(ACK))),
    );
    sender.record([{ from: 0, to: 10 }], 10);
    const first = sender.flush();
    sender.record([{ from: 10, to: 20 }], 20);
    void sender.flush();
    expect(sent).toHaveLength(1);
    release();
    await first;
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.body.ranges).toEqual([{ from: 10, to: 20 }]);
  });

  it('keepalive (leaving the page) does not wait for the request in flight', () => {
    const { sender, sent } = setup(() => new Promise<ProgressAck>(() => undefined));
    sender.record([{ from: 0, to: 10 }], 10);
    void sender.flush();
    sender.record([{ from: 10, to: 12 }], 12);
    void sender.flush({ keepalive: true });
    expect(sent.map((s) => s.keepalive)).toEqual([false, true]);
    expect(sent[1]!.body.ranges).toEqual([{ from: 10, to: 12 }]);
  });

  it('drops a 429 batch silently (design §9)', async () => {
    let status = 429;
    const { sender, sent, onStopped } = setup(async () => {
      if (status) throw new HttpError(status);
      return ACK;
    });
    sender.record([{ from: 0, to: 10 }], 10);
    await sender.flush();
    status = 0;
    sender.record([{ from: 10, to: 20 }], 20);
    await sender.flush();
    expect(sent.map((s) => s.body.ranges)).toEqual([[{ from: 0, to: 10 }], [{ from: 10, to: 20 }]]);
    expect(onStopped).not.toHaveBeenCalled();
  });

  it('keeps the batch after a 503 or a network error and sends it with the next beat', async () => {
    const failures = [new HttpError(503), new TypeError('Failed to fetch')];
    const { sender, sent } = setup(async () => {
      const failure = failures.shift();
      if (failure) throw failure;
      return ACK;
    });
    sender.record([{ from: 0, to: 10 }], 10);
    await sender.flush();
    await sender.flush();
    sender.record([{ from: 10, to: 20 }], 20);
    await sender.flush();
    expect(sent.at(-1)!.body.ranges).toEqual([{ from: 0, to: 20 }]);
  });

  it('stops for good on another 4xx (enrollment revoked, not a video)', async () => {
    const { sender, sent, onStopped } = setup(async () => {
      throw new HttpError(403);
    });
    sender.record([{ from: 0, to: 10 }], 10);
    await sender.flush();
    expect(onStopped).toHaveBeenCalledWith({ status: 403 });
    sender.record([{ from: 10, to: 20 }], 20);
    await sender.flush();
    expect(sent).toHaveLength(1);
    expect(sender.isStopped).toBe(true);
  });
});
