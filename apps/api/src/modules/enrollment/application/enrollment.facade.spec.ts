import { randomUUID } from 'node:crypto';
import { EnrollmentGranted, EnrollmentRevoked } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import { InvalidEnrollmentReason } from '../domain/enrollment.errors';
import { decodeMyLearningCursor, encodeMyLearningCursor } from './enrollment-cursor';
import { isUuid, transitionId } from './ids';
import { createEnrollmentHarness, FAKE_TRX } from './testing/enrollment.fakes';

const REASON = 'Support goodwill grant after an outage';

describe('EnrollmentFacade.grant', () => {
  it('GRANTED -> ALREADY_ACTIVE: one EnrollmentGranted, newlyGranted only the first time', async () => {
    const h = createEnrollmentHarness();
    const userId = randomUUID();
    const courseId = randomUUID();

    const first = await h.facade.grant(FAKE_TRX, { userId, courseId, source: 'FREE' });
    const again = await h.facade.grant(FAKE_TRX, { userId, courseId, source: 'FREE' });

    expect(first).toEqual({
      enrollmentId: expect.any(String),
      outcome: 'GRANTED',
      newlyGranted: true,
    });
    expect(again).toEqual({
      enrollmentId: first.enrollmentId,
      outcome: 'ALREADY_ACTIVE',
      newlyGranted: false,
    });
    expect(h.events.events).toHaveLength(1);
    const [event] = h.events.events;
    expect(event?.type).toBe('granted');
    expect(event?.payload).toMatchObject({
      enrollmentId: first.enrollmentId,
      userId,
      courseId,
      source: 'FREE',
      orderLineId: null,
      regrant: false,
    });
    // the payload satisfies the published event contract
    expect(EnrollmentGranted.safeParsePayload(event?.payload).success).toBe(true);
  });

  it('ORDER carries the order line; a regrant after a refund is flagged', async () => {
    const h = createEnrollmentHarness();
    const userId = randomUUID();
    const courseId = randomUUID();
    const orderLineId = randomUUID();
    const refundId = randomUUID();

    await h.facade.grant(FAKE_TRX, { userId, courseId, source: 'ORDER', orderLineId });
    const revoked = await h.facade.revoke(FAKE_TRX, {
      userId,
      courseId,
      cause: 'REFUND',
      refundId,
    });
    const regrant = await h.facade.grant(FAKE_TRX, {
      userId,
      courseId,
      source: 'ORDER',
      orderLineId: randomUUID(),
    });

    expect(revoked.outcome).toBe('REVOKED');
    expect(regrant).toMatchObject({ outcome: 'REGRANTED', newlyGranted: true });
    expect(h.events.events.map((e) => e.type)).toEqual(['granted', 'revoked', 'granted']);
    const [granted, revokedEvent, regranted] = h.events.events;
    expect(granted?.payload).toMatchObject({ orderLineId, regrant: false });
    expect(revokedEvent?.payload).toMatchObject({ reason: 'REFUND', refundId, actorId: null });
    expect(EnrollmentRevoked.safeParsePayload(revokedEvent?.payload).success).toBe(true);
    expect(regranted?.payload).toMatchObject({ regrant: true });
  });

  it('ADMIN without a valid reason or actor fails with 422 before touching the repository', async () => {
    const h = createEnrollmentHarness();
    const input = { userId: randomUUID(), courseId: randomUUID(), source: 'ADMIN' as const };
    await expect(h.facade.grant(FAKE_TRX, input)).rejects.toThrow(InvalidEnrollmentReason);
    await expect(
      h.facade.grant(FAKE_TRX, { ...input, actorId: randomUUID(), reason: 'short' }),
    ).rejects.toThrow(InvalidEnrollmentReason);
    expect(h.repo.calls).toEqual([]);
    await expect(
      h.facade.grant(FAKE_TRX, { ...input, actorId: randomUUID(), reason: REASON }),
    ).resolves.toMatchObject({ outcome: 'GRANTED' });
  });

  it('an orderLineId mismatch is a caller bug (RangeError), and nothing is emitted', async () => {
    const h = createEnrollmentHarness();
    const base = { userId: randomUUID(), courseId: randomUUID() };
    await expect(h.facade.grant(FAKE_TRX, { ...base, source: 'ORDER' })).rejects.toThrow(
      RangeError,
    );
    await expect(
      h.facade.grant(FAKE_TRX, { ...base, source: 'FREE', orderLineId: randomUUID() }),
    ).rejects.toThrow(RangeError);
    expect(h.events.events).toEqual([]);
  });
});

describe('EnrollmentFacade.revoke', () => {
  it('NOT_ACTIVE for no enrollment and for an already revoked one; no event', async () => {
    const h = createEnrollmentHarness();
    const userId = randomUUID();
    const courseId = randomUUID();
    const admin = { cause: 'ADMIN' as const, actorId: randomUUID(), reason: REASON };

    expect(await h.facade.revoke(FAKE_TRX, { userId, courseId, ...admin })).toEqual({
      enrollmentId: null,
      outcome: 'NOT_ACTIVE',
    });
    const { enrollmentId } = await h.facade.grant(FAKE_TRX, { userId, courseId, source: 'FREE' });
    expect(await h.facade.revoke(FAKE_TRX, { userId, courseId, ...admin })).toEqual({
      enrollmentId,
      outcome: 'REVOKED',
    });
    expect(await h.facade.revoke(FAKE_TRX, { userId, courseId, ...admin })).toEqual({
      enrollmentId,
      outcome: 'NOT_ACTIVE',
    });
    expect(h.events.events.map((e) => e.type)).toEqual(['granted', 'revoked']);
    expect(h.events.events[1]?.payload).toMatchObject({ reason: 'ADMIN', actorId: admin.actorId });
  });

  it('ADMIN / CHARGEBACK need an actor and a reason', async () => {
    const h = createEnrollmentHarness();
    const base = { userId: randomUUID(), courseId: randomUUID() };
    await expect(h.facade.revoke(FAKE_TRX, { ...base, cause: 'ADMIN' })).rejects.toThrow(
      InvalidEnrollmentReason,
    );
    await expect(
      h.facade.revoke(FAKE_TRX, { ...base, cause: 'CHARGEBACK', reason: REASON }),
    ).rejects.toThrow(InvalidEnrollmentReason);
    expect(h.repo.calls).toEqual([]);
  });
});

describe('EnrollmentFacade reads and EnrollmentEntitlements', () => {
  it('activeCourseIds filters to ACTIVE rows among the given ids (all when omitted)', async () => {
    const h = createEnrollmentHarness();
    const userId = randomUUID();
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    for (const courseId of [a, b, c]) {
      await h.facade.grant(FAKE_TRX, { userId, courseId, source: 'FREE' });
    }
    await h.facade.revoke(FAKE_TRX, {
      userId,
      courseId: b,
      cause: 'ADMIN',
      actorId: randomUUID(),
      reason: REASON,
    });

    expect(await h.facade.activeCourseIds(userId)).toEqual(new Set([a, c]));
    expect(await h.facade.activeCourseIds(userId, [a, b, a, 'junk'])).toEqual(new Set([a]));
    h.repo.calls.length = 0;
    expect(await h.facade.activeCourseIds(userId, ['junk'])).toEqual(new Set());
    expect(await h.facade.activeCourseIds(userId, [])).toEqual(new Set());
    expect(await h.facade.activeCourseIds('junk', [a])).toEqual(new Set());
    expect(h.repo.calls).toEqual([]);
  });

  it('hasAccess / hasCourseAccess: ACTIVE only; malformed ids never reach the repository', async () => {
    const h = createEnrollmentHarness();
    const userId = randomUUID();
    const courseId = randomUUID();
    expect(await h.entitlements.hasCourseAccess(userId, courseId)).toBe(false);
    await h.facade.grant(FAKE_TRX, { userId, courseId, source: 'FREE' });
    expect(await h.entitlements.hasCourseAccess(userId, courseId)).toBe(true);
    expect(await h.facade.hasAccess(userId, courseId)).toBe(true);
    await h.facade.revoke(FAKE_TRX, {
      userId,
      courseId,
      cause: 'REFUND',
      refundId: randomUUID(),
    });
    expect(await h.entitlements.hasCourseAccess(userId, courseId)).toBe(false);

    h.repo.calls.length = 0;
    expect(await h.entitlements.hasCourseAccess('x', courseId)).toBe(false);
    expect(await h.facade.hasAccess(userId, 'y')).toBe(false);
    expect(h.repo.calls).toEqual([]);
  });
});

describe('ids and cursors', () => {
  it('transitionId is a stable RFC 9562 v5 UUID per (enrollment, seq)', () => {
    const enrollmentId = randomUUID();
    const one = transitionId(enrollmentId, 1);
    expect(isUuid(one)).toBe(true);
    expect(one[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(one[19]);
    expect(transitionId(enrollmentId, 1)).toBe(one);
    expect(transitionId(enrollmentId, 2)).not.toBe(one);
    expect(transitionId(randomUUID(), 1)).not.toBe(one);
  });

  it('the My learning cursor round-trips the exact SQL timestamp text and rejects forgeries', () => {
    const keyset = { grantedAt: '2026-10-10T12:00:00.123456Z', id: randomUUID() };
    expect(decodeMyLearningCursor(encodeMyLearningCursor(keyset))).toEqual(keyset);
    const forged = Buffer.from(
      JSON.stringify({ g: '2026-10-10T12:00:00.123Z', i: keyset.id }),
    ).toString('base64url');
    for (const bad of [forged, 'not-json', Buffer.from('[]').toString('base64url')]) {
      expect(() => decodeMyLearningCursor(bad)).toThrow(
        expect.objectContaining({ code: 'validation_failed' }),
      );
    }
  });
});
