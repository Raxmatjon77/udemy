import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuidv7';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('has the v7 version and RFC 9562 variant bits', () => {
    for (let i = 0; i < 100; i += 1) expect(uuidv7()).toMatch(UUID_V7);
  });

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0, 123);
    const id = uuidv7(now);
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(now);
  });

  it('sorts by creation time', () => {
    const ids = [1_000, 2_000, 3_000].map((t) => uuidv7(1_700_000_000_000 + t));
    expect([...ids].sort()).toEqual(ids);
  });
});
