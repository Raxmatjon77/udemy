import { createHash } from 'node:crypto';
import { REALTIME_LIMITS, REALTIME_TICKET_PATTERN } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { type RedisClient, RedisUnavailableError } from '../redis';
import { RedisWsTicketStore, wsTicketKey } from './redis-ws-ticket.store';
import { studentGrant } from './testing/realtime.fakes';

/** The two commands the store uses, with Redis semantics (TTL recorded, not enforced). */
class FakeRedis {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  down = false;

  set(key: string, value: string, ex: 'EX', seconds: number, nx: 'NX'): Promise<'OK' | null> {
    if (this.down) return Promise.reject(new Error('connection is closed'));
    expect([ex, nx]).toEqual(['EX', 'NX']);
    if (this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    this.ttls.set(key, seconds);
    return Promise.resolve('OK');
  }

  getdel(key: string): Promise<string | null> {
    if (this.down) return Promise.reject(new Error('connection is closed'));
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return Promise.resolve(value);
  }
}

function setup() {
  const redis = new FakeRedis();
  return { redis, store: new RedisWsTicketStore(redis as unknown as RedisClient) };
}

describe('RedisWsTicketStore', () => {
  it('stores only the SHA-256 of a 43-character base64url ticket, for 30 s', async () => {
    const { redis, store } = setup();
    const before = Date.now();
    const { ticket, expiresAt } = await store.issue(studentGrant());

    expect(ticket).toMatch(REALTIME_TICKET_PATTERN);
    const key = `ws:tkt:${createHash('sha256').update(ticket).digest('hex')}`;
    expect(wsTicketKey(ticket)).toBe(key);
    expect([...redis.values.keys()]).toEqual([key]);
    expect(redis.values.get(key)).not.toContain(ticket);
    expect(redis.ttls.get(key)).toBe(REALTIME_LIMITS.ticketTtlSeconds);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + REALTIME_LIMITS.ticketTtlSeconds * 1000,
    );
  });

  it('redeems a ticket once and returns the grant it was issued for', async () => {
    const { store } = setup();
    const grant = studentGrant({ roles: ['STUDENT', 'INSTRUCTOR'] });
    const { ticket } = await store.issue(grant);

    await expect(store.consume(ticket)).resolves.toEqual(grant);
    await expect(store.consume(ticket)).resolves.toBeNull();
  });

  it('issues a different ticket every time', async () => {
    const { store } = setup();
    const a = await store.issue(studentGrant());
    const b = await store.issue(studentGrant());
    expect(a.ticket).not.toBe(b.ticket);
  });

  it('never queries Redis for a malformed ticket, and refuses an unreadable value', async () => {
    const { redis, store } = setup();
    redis.down = true;
    await expect(store.consume('not-a-ticket')).resolves.toBeNull();
    redis.down = false;

    const ticket = 'A'.repeat(43);
    redis.values.set(wsTicketKey(ticket), '{"v":2}');
    await expect(store.consume(ticket)).resolves.toBeNull();
    redis.values.set(wsTicketKey(ticket), 'not json');
    await expect(store.consume(ticket)).resolves.toBeNull();
  });

  it('fails closed: Redis errors are RedisUnavailableError', async () => {
    const { redis, store } = setup();
    redis.down = true;
    await expect(store.issue(studentGrant())).rejects.toBeInstanceOf(RedisUnavailableError);
    await expect(store.consume('A'.repeat(43))).rejects.toBeInstanceOf(RedisUnavailableError);
  });
});
