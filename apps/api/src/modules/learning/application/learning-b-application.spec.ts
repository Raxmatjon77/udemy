import { ErrorCode } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { certificateTransitionId } from './certificate.presenter';
import { decodeLearningCursor, encodeLearningCursor } from './learning-cursor';

const Q1 = '01900000-0000-7000-8000-0000000c0001';

describe('cursor and ids', () => {
  it('round-trips the exact SQL timestamp text and refuses anything else', () => {
    const keyset = { at: '2026-10-24T12:00:00.123456Z', id: Q1 };
    expect(decodeLearningCursor(encodeLearningCursor(keyset))).toEqual(keyset);
    const forged = Buffer.from(JSON.stringify({ t: '2026-10-24T12:00:00Z', i: Q1 })).toString(
      'base64url',
    );
    expect(() => decodeLearningCursor(forged)).toThrowError(
      expect.objectContaining({ code: ErrorCode.ValidationFailed }),
    );
  });

  it('certificate transition ids are deterministic RFC 9562 v8 uuids', () => {
    const id = certificateTransitionId(Q1, 1);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(certificateTransitionId(Q1.toUpperCase(), 1)).toBe(id);
    expect(certificateTransitionId(Q1, 2)).not.toBe(id);
  });
});
