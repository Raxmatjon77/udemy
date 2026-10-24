import { randomUUID } from 'node:crypto';
import { CourseRatingSchema, ErrorCode, WISHLIST_LIMITS } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import {
  isPublished,
  isRepliable,
  publicReplyOf,
  reviewBlockReason,
  reviewState,
  toCourseRating,
} from './review';
import { decideWishlistAdd, isWishlistFull } from './wishlist';

const AT = new Date('2026-10-01T12:00:00Z');

describe('review state (design §4 Review)', () => {
  it.each([
    ['VISIBLE', null, 'PUBLISHED'],
    ['HIDDEN', null, 'HIDDEN'],
    ['VISIBLE', AT, 'SUSPENDED'],
    // suspension wins: the author can fix it by re-enrolling
    ['HIDDEN', AT, 'SUSPENDED'],
  ] as const)('%s + suspendedAt=%s -> %s', (moderationStatus, suspendedAt, state) => {
    expect(reviewState({ moderationStatus, suspendedAt })).toBe(state);
    expect(isPublished({ moderationStatus, suspendedAt })).toBe(state === 'PUBLISHED');
  });

  it('replies go to published or hidden reviews, never to suspended ones', () => {
    expect(isRepliable({ suspendedAt: null })).toBe(true);
    expect(isRepliable({ suspendedAt: AT })).toBe(false);
  });

  it('a hidden reply is not shown publicly', () => {
    const reply = {
      id: 'r',
      reviewId: 'v',
      authorId: 'a',
      body: 'Thanks',
      createdAt: AT,
      editedAt: null,
    };
    expect(publicReplyOf({ reply: { ...reply, moderationStatus: 'VISIBLE' } })).not.toBeNull();
    expect(publicReplyOf({ reply: { ...reply, moderationStatus: 'HIDDEN' } })).toBeNull();
    expect(publicReplyOf({ reply: null })).toBeNull();
  });
});

describe('review eligibility (D10, P5-D8)', () => {
  it('checks owner, then enrollment, then completed lectures', () => {
    expect(
      reviewBlockReason({ isOwner: true, hasActiveEnrollment: true, completedLectures: 9 }),
    ).toBe(ErrorCode.CannotReviewOwnCourse);
    expect(
      reviewBlockReason({ isOwner: false, hasActiveEnrollment: false, completedLectures: 9 }),
    ).toBe(ErrorCode.EnrollmentRequired);
    expect(
      reviewBlockReason({ isOwner: false, hasActiveEnrollment: true, completedLectures: 0 }),
    ).toBe(ErrorCode.ReviewNotEligible);
    expect(
      reviewBlockReason({ isOwner: false, hasActiveEnrollment: true, completedLectures: 1 }),
    ).toBeNull();
  });
});

describe('toCourseRating (D11 read model)', () => {
  it('a course without a read-model row has no reviews (count 0, average null)', () => {
    const rating = toCourseRating('c', undefined);
    expect(rating).toEqual({
      courseId: 'c',
      average: null,
      count: 0,
      histogram: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    });
    expect(CourseRatingSchema.safeParse({ ...rating, courseId: randomUUID() }).success).toBe(true);
  });

  it('maps the histogram and keeps the generated average', () => {
    const rating = toCourseRating('c', {
      courseId: 'c',
      reviewCount: 3,
      average: '4.3',
      counts: [0, 0, 0, 2, 1],
    });
    expect(rating).toMatchObject({ average: '4.3', count: 3, histogram: { '4': 2, '5': 1 } });
  });

  it('recomputes the average with the read model rounding when it is missing', () => {
    // (4 + 4 + 5) / 3 = 4.333... -> 4.3; (4 + 5) / 2 = 4.5 -> 4.5
    expect(
      toCourseRating('c', { courseId: 'c', reviewCount: 3, average: null, counts: [0, 0, 0, 2, 1] })
        .average,
    ).toBe('4.3');
    expect(
      toCourseRating('c', { courseId: 'c', reviewCount: 2, average: null, counts: [0, 0, 0, 1, 1] })
        .average,
    ).toBe('4.5');
  });
});

describe('wishlist rules (D19)', () => {
  const course = { ownerId: 'owner', status: 'PUBLISHED' as const };

  it('only published courses the caller neither owns nor is enrolled in', () => {
    expect(decideWishlistAdd({ course: null, userId: 'u', hasActiveEnrollment: false })).toBe(
      'COURSE_NOT_FOUND',
    );
    expect(decideWishlistAdd({ course, userId: 'u', hasActiveEnrollment: false })).toBe('ELIGIBLE');
    expect(decideWishlistAdd({ course, userId: 'owner', hasActiveEnrollment: false })).toBe(
      'NOT_WISHLISTABLE',
    );
    expect(decideWishlistAdd({ course, userId: 'u', hasActiveEnrollment: true })).toBe(
      'NOT_WISHLISTABLE',
    );
    expect(
      decideWishlistAdd({
        course: { ...course, status: 'ARCHIVED' },
        userId: 'u',
        hasActiveEnrollment: false,
      }),
    ).toBe('NOT_WISHLISTABLE');
  });

  it('is full at WISHLIST_LIMITS.maxItems', () => {
    expect(isWishlistFull(WISHLIST_LIMITS.maxItems - 1)).toBe(false);
    expect(isWishlistFull(WISHLIST_LIMITS.maxItems)).toBe(true);
  });
});
