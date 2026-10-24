import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@udemy/nest-common/errors';
import { decodeKeyset, decodeOptionalKeyset, encodeKeyset, toPage } from './engagement-cursor';

describe('engagement keyset cursor', () => {
  const keyset = { at: '2026-10-01T12:00:00.123456Z', id: randomUUID() };

  it('round-trips the exact SQL timestamp text (microseconds kept)', () => {
    const cursor = encodeKeyset(keyset);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeKeyset(cursor)).toEqual(keyset);
    expect(decodeOptionalKeyset(undefined)).toBeNull();
  });

  it.each([
    ['not base64 json', 'abc'],
    ['millisecond precision', encodeKeyset({ ...keyset, at: '2026-10-01T12:00:00.123Z' })],
    ['not a uuid', encodeKeyset({ ...keyset, id: 'x' })],
  ])('rejects %s with 422 validation_failed', (_name, cursor) => {
    expect(() => decodeKeyset(cursor)).toThrow(ValidationError);
  });

  it('toPage: next cursor only when the limit+1 fetch overflowed', () => {
    const rows = [1, 2, 3].map((n) => ({ n, key: { at: keyset.at, id: randomUUID() } }));
    const full = toPage(
      rows,
      2,
      (r) => r.key,
      (page) => page.map((r) => r.n),
    );
    expect(full.items).toEqual([1, 2]);
    expect(decodeKeyset(full.nextCursor ?? '')).toEqual(rows[1]?.key);
    const last = toPage(
      rows.slice(0, 2),
      2,
      (r) => r.key,
      (page) => page.map((r) => r.n),
    );
    expect(last).toEqual({ items: [1, 2], nextCursor: null });
  });
});
