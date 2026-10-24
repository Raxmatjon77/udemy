import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../../../shared/config';
import { HmacUnsubscribeTokenCodec } from './hmac-unsubscribe-token.codec';

const USER = '01900000-0000-7000-8000-0000000000a1';
const SECRET = 'dev-notifications-unsubscribe-secret-change-me-0000';

function codec(secret = SECRET): HmacUnsubscribeTokenCodec {
  return new HmacUnsubscribeTokenCodec({ get: () => secret } as unknown as AppConfigService);
}

describe('HmacUnsubscribeTokenCodec', () => {
  it('signs v1.{userId}.{category}.{base64url HMAC-SHA256 of v1|userId|category}', () => {
    const token = codec().sign({ userId: USER, category: 'ANNOUNCEMENTS' });
    const mac = createHmac('sha256', SECRET).update(`v1|${USER}|ANNOUNCEMENTS`).digest('base64url');

    expect(token).toBe(`v1.${USER}.ANNOUNCEMENTS.${mac}`);
    expect(mac).toHaveLength(43);
    expect(token.length).toBeLessThanOrEqual(512); // UnsubscribeRequestSchema
  });

  it('verifies its own tokens', () => {
    const c = codec();
    expect(c.verify(c.sign({ userId: USER, category: 'QA' }))).toEqual({
      userId: USER,
      category: 'QA',
    });
  });

  it('rejects forgeries, tampering and malformed tokens', () => {
    const c = codec();
    const token = c.sign({ userId: USER, category: 'QA' });
    const [, , , mac = ''] = token.split('.');
    const flipped = `${mac.slice(0, -2)}${mac.at(-2) === 'A' ? 'B' : 'A'}${mac.slice(-1)}`;
    const otherUser = '01900000-0000-7000-8000-0000000000b0';

    for (const bad of [
      codec('another-secret-of-at-least-32-characters!').sign({ userId: USER, category: 'QA' }),
      token.replace('.QA.', '.REVIEWS.'),
      token.replace(USER, otherUser),
      token.replace(/^v1\./, 'v2.'),
      `v1.${USER}.QA.${flipped}`,
      `v1.${USER.toUpperCase()}.QA.${mac}`,
      `v1.${USER}.QA.${mac}=`,
      `v1.${USER}.QA`,
      `${token}.extra`,
      '',
    ]) {
      expect(c.verify(bad), bad).toBeNull();
    }
  });

  it('accepts exactly one encoding of a MAC (no spare-bit variants)', () => {
    const c = codec();
    const token = c.sign({ userId: USER, category: 'QA' });
    const last = token.at(-1) ?? 'A';
    // The 43rd base64url character carries 2 spare bits; flipping them decodes to the same bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const variant = alphabet[alphabet.indexOf(last) ^ 1] ?? 'A';
    expect(c.verify(`${token.slice(0, -1)}${variant}`)).toBeNull();
  });

  it('never issues or accepts a token for a locked category (MODERATION)', () => {
    const c = codec();
    expect(() => c.sign({ userId: USER, category: 'MODERATION' })).toThrow(TypeError);
    const mac = createHmac('sha256', SECRET).update(`v1|${USER}|MODERATION`).digest('base64url');
    expect(c.verify(`v1.${USER}.MODERATION.${mac}`)).toBeNull();
  });
});
