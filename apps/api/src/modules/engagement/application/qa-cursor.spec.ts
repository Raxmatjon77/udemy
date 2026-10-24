import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeQuestionCursor, encodeQuestionCursor } from './qa-cursor';

describe('Q&A question cursor', () => {
  const id = randomUUID();

  it.each([
    { sort: 'recent' as const, lastActivityAt: '2026-10-24 09:15:02.123456+00', id },
    { sort: 'top' as const, upvoteCount: 17, id },
    { sort: 'unanswered' as const, createdAt: '2026-10-24T09:15:02.000001Z', id },
  ])('round-trips the exact SQL key of $sort', (cursor) => {
    const encoded = encodeQuestionCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeQuestionCursor(encoded, cursor.sort)).toEqual(cursor);
  });

  it('absent cursor = first page', () => {
    expect(decodeQuestionCursor(undefined, 'top')).toBeNull();
  });

  it('refuses another sort, foreign JSON, non-timestamps and garbage (422 validation_failed)', () => {
    const recent = encodeQuestionCursor({
      sort: 'recent',
      lastActivityAt: '2026-10-24 09:15:02+00',
      id,
    });
    const forge = (raw: unknown) => Buffer.from(JSON.stringify(raw)).toString('base64url');
    for (const [cursor, sort] of [
      [recent, 'top'],
      [forge({ s: 'recent', t: "now'; DROP TABLE x", i: id }), 'recent'],
      [forge({ s: 'top', v: -1, i: id }), 'top'],
      [forge({ s: 'top', v: 1, i: 'not-a-uuid' }), 'top'],
      ['%%%', 'recent'],
    ] as const) {
      expect(() => decodeQuestionCursor(cursor, sort)).toThrow(
        expect.objectContaining({ code: 'validation_failed' }),
      );
    }
  });
});
