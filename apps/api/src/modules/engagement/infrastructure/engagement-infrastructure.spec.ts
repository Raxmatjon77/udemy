import { ErrorCode } from '@udemy/contracts';
import { describe, expect, it, vi } from 'vitest';
import { RateLimitedError } from '../../../shared/errors';
import type { RateLimiter } from '../../../shared/redis';
import { ENGAGEMENT_API_RATE_LIMITS } from '../application/ports/engagement-rate-limiter';
import {
  CannotReportOwnContent,
  InvalidEngagementInput,
  ReplyNotFound,
  ReviewNotFound,
} from '../domain/engagement.errors';
import {
  mapEngagementConstraints,
  rethrowEngagementConstraint,
} from './engagement-constraint-errors';
import {
  engagementRateLimitKey,
  RedisEngagementRateLimiter,
} from './redis-engagement-rate-limiter';
import { toReviewRecord } from './row-mapping';

const pgError = (constraint: string, code = '23514') =>
  Object.assign(new Error(`violates ${constraint}`), { code, constraint });

describe('engagement constraint -> domain error map (schema doc §9)', () => {
  it.each([
    ['reviews_rating_ck', InvalidEngagementInput],
    ['reviews_body_ck', InvalidEngagementInput],
    ['review_replies_body_ck', InvalidEngagementInput],
    ['review_reports_comment_ck', InvalidEngagementInput],
    ['reviews_immutable_ck', ReviewNotFound],
    ['review_replies_immutable_ck', ReplyNotFound],
    ['review_reports_own_content_ck', CannotReportOwnContent],
    ['review_reply_reports_own_content_ck', CannotReportOwnContent],
    ['review_reports_subject_id_fk', ReviewNotFound],
    ['review_reply_reports_subject_id_fk', ReplyNotFound],
  ])('%s', (constraint, type) => {
    const cause = pgError(constraint);
    let thrown: unknown;
    try {
      rethrowEngagementConstraint(cause);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(type);
    expect((thrown as Error).cause).toBe(cause);
  });

  it('keeps unmapped errors (deferred moderation log, 42501) as they are (500)', async () => {
    const deferred = pgError('moderation_status_log_ck');
    const appendOnly = Object.assign(new Error('append-only'), { code: '42501' });
    await expect(mapEngagementConstraints(() => Promise.reject(deferred))).rejects.toBe(deferred);
    await expect(mapEngagementConstraints(() => Promise.reject(appendOnly))).rejects.toBe(
      appendOnly,
    );
    await expect(mapEngagementConstraints(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('own-content problems carry the contract code', () => {
    expect(new CannotReportOwnContent().code).toBe(ErrorCode.CannotReportOwnContent);
  });
});

describe('RedisEngagementRateLimiter', () => {
  it('keys per rule and scope (rl:eng:*), with the contract windows', async () => {
    const hit = vi.fn(async () => ({ count: 1, ttlMs: 1000, limited: false }));
    const limiter = new RedisEngagementRateLimiter({ hit } as unknown as RateLimiter);

    await limiter.hit('reviewWrite', 'u1');
    await limiter.hit('publicRead', '203.0.113.7');

    expect(engagementRateLimitKey('reviewWrite', 'u1')).toBe('rl:eng:reviewWrite:u:u1');
    expect(hit).toHaveBeenNthCalledWith(1, 'rl:eng:reviewWrite:u:u1', {
      limit: 20,
      windowMs: 86_400_000,
    });
    expect(hit).toHaveBeenNthCalledWith(2, 'rl:eng:publicRead:ip:203.0.113.7', {
      limit: 240,
      windowMs: 60_000,
    });
    expect(ENGAGEMENT_API_RATE_LIMITS.reviewReply).toEqual({
      limit: 100,
      windowSeconds: 86_400,
      per: 'instructor',
    });
  });

  it('throws 429 rate_limited with Retry-After once limited', async () => {
    const limiter = new RedisEngagementRateLimiter({
      hit: async () => ({ count: 31, ttlMs: 4500, limited: true }),
    } as unknown as RateLimiter);
    const error = await limiter.hit('report', 'u1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(5);
  });
});

describe('toReviewRecord', () => {
  const base = {
    id: 'r1',
    courseId: 'c1',
    userId: 'u1',
    rating: 4,
    body: null,
    moderationStatus: 'VISIBLE',
    suspendedAt: null,
    createdAt: new Date(0),
    editedAt: null,
  };
  const noReply = {
    replyId: null,
    replyAuthorId: null,
    replyBody: null,
    replyModerationStatus: null,
    replyCreatedAt: null,
    replyEditedAt: null,
  };

  it('maps the outer-joined live reply, or null without one', () => {
    expect(toReviewRecord({ ...base, ...noReply }).reply).toBeNull();
    expect(
      toReviewRecord({
        ...base,
        ...noReply,
        replyId: 'p1',
        replyAuthorId: 'o1',
        replyBody: 'Thanks',
        replyModerationStatus: 'HIDDEN',
        replyCreatedAt: new Date(1),
      }).reply,
    ).toEqual({
      id: 'p1',
      reviewId: 'r1',
      authorId: 'o1',
      body: 'Thanks',
      moderationStatus: 'HIDDEN',
      createdAt: new Date(1),
      editedAt: null,
    });
  });

  it('an unknown moderation status is a bug (500), never silently public', () => {
    expect(() => toReviewRecord({ ...base, ...noReply, moderationStatus: 'BOGUS' })).toThrow(
      /Unexpected reviews.moderation_status/,
    );
  });
});
