import { describe, expect, it } from 'vitest';
import {
  CourseNotEditable,
  InvalidStateTransition,
  RestoreForbidden,
  ReviewAlreadyPending,
  SelfDecisionForbidden,
  VersionConflict,
} from './catalog.errors';
import type { CourseLifecycle } from './course';
import {
  planApprove,
  planArchive,
  planReject,
  planRestore,
  planSubmit,
  planWithdraw,
  revisionState,
} from './lifecycle';

const OWNER = 'owner';
const ADMIN = 'admin';
const draft: CourseLifecycle & { ownerId: string } = {
  ownerId: OWNER,
  status: 'DRAFT',
  version: 3,
  pendingRevisionId: null,
  publishedRevisionId: null,
  firstPublishedAt: null,
};
const inReview = { ...draft, status: 'IN_REVIEW' as const, pendingRevisionId: 'r1' };
const live = {
  ...draft,
  status: 'PUBLISHED' as const,
  publishedRevisionId: 'r1',
  firstPublishedAt: new Date(),
};
const liveUpdate = { ...live, pendingRevisionId: 'r2' };
const archived = { ...live, status: 'ARCHIVED' as const };

describe('course state machine (design §4)', () => {
  it('SUBMIT: DRAFT/REJECTED -> IN_REVIEW (INITIAL), PUBLISHED -> PUBLISHED (UPDATE)', () => {
    expect(planSubmit(draft)).toEqual({
      fromStatus: 'DRAFT',
      toStatus: 'IN_REVIEW',
      kind: 'INITIAL',
    });
    expect(planSubmit({ ...draft, status: 'REJECTED' })).toMatchObject({
      fromStatus: 'REJECTED',
      toStatus: 'IN_REVIEW',
    });
    expect(planSubmit(live)).toEqual({
      fromStatus: 'PUBLISHED',
      toStatus: 'PUBLISHED',
      kind: 'UPDATE',
    });
    expect(() => planSubmit(inReview)).toThrow(ReviewAlreadyPending);
    expect(() => planSubmit(liveUpdate)).toThrow(ReviewAlreadyPending);
    expect(() => planSubmit(archived)).toThrow(CourseNotEditable);
  });

  it('WITHDRAW: IN_REVIEW -> DRAFT, a pending update keeps PUBLISHED, nothing pending is 409', () => {
    expect(planWithdraw(inReview)).toEqual({
      fromStatus: 'IN_REVIEW',
      toStatus: 'DRAFT',
      revisionId: 'r1',
    });
    expect(planWithdraw(liveUpdate)).toEqual({
      fromStatus: 'PUBLISHED',
      toStatus: 'PUBLISHED',
      revisionId: 'r2',
    });
    expect(() => planWithdraw(draft)).toThrow(InvalidStateTransition);
    expect(() => planWithdraw(live)).toThrow(InvalidStateTransition);
  });

  it('APPROVE: the pending revision goes live; the old live revision is superseded', () => {
    const decide = { ownerId: OWNER, actorId: ADMIN };
    expect(planApprove(inReview, { ...decide, revisionId: 'r1' })).toEqual({
      fromStatus: 'IN_REVIEW',
      toStatus: 'PUBLISHED',
      supersededRevisionId: null,
    });
    expect(planApprove(liveUpdate, { ...decide, revisionId: 'r2' })).toEqual({
      fromStatus: 'PUBLISHED',
      toStatus: 'PUBLISHED',
      supersededRevisionId: 'r1',
    });
  });

  it('decisions: self-decision 403 first, then version, then "is it the pending revision"', () => {
    const self = { ownerId: OWNER, actorId: OWNER, revisionId: 'stale', expectedVersion: 1 };
    expect(() => planApprove(inReview, self)).toThrow(SelfDecisionForbidden);
    expect(() => planReject(inReview, self)).toThrow(SelfDecisionForbidden);
    const admin = { ownerId: OWNER, actorId: ADMIN };
    expect(() => planApprove(inReview, { ...admin, revisionId: 'r1', expectedVersion: 2 })).toThrow(
      VersionConflict,
    );
    expect(() => planApprove(inReview, { ...admin, revisionId: 'r0' })).toThrow(
      InvalidStateTransition,
    );
    expect(() => planReject(draft, { ...admin, revisionId: 'r1' })).toThrow(InvalidStateTransition);
    expect(planApprove(inReview, { ...admin, revisionId: 'r1', expectedVersion: 3 })).toBeTruthy();
  });

  it('REJECT: first submission -> REJECTED, a rejected update keeps the course live', () => {
    const admin = { ownerId: OWNER, actorId: ADMIN };
    expect(planReject(inReview, { ...admin, revisionId: 'r1' })).toEqual({
      fromStatus: 'IN_REVIEW',
      toStatus: 'REJECTED',
    });
    expect(planReject(liveUpdate, { ...admin, revisionId: 'r2' })).toEqual({
      fromStatus: 'PUBLISHED',
      toStatus: 'PUBLISHED',
    });
  });

  it('ARCHIVE: only PUBLISHED; a pending update is withdrawn first', () => {
    expect(planArchive(live)).toEqual({
      fromStatus: 'PUBLISHED',
      toStatus: 'ARCHIVED',
      pendingToWithdraw: null,
    });
    expect(planArchive(liveUpdate).pendingToWithdraw).toBe('r2');
    for (const course of [draft, inReview, archived, { ...draft, status: 'REJECTED' as const }]) {
      expect(() => planArchive(course)).toThrow(InvalidStateTransition);
    }
  });

  it('RESTORE: admin always; owner only after their own archive', () => {
    const byOwner = { action: 'ARCHIVE' as const, actorId: OWNER };
    const byAdmin = { action: 'ARCHIVE' as const, actorId: ADMIN };
    expect(planRestore(archived, byOwner, false)).toEqual({
      fromStatus: 'ARCHIVED',
      toStatus: 'PUBLISHED',
    });
    expect(() => planRestore(archived, byAdmin, false)).toThrow(RestoreForbidden);
    expect(planRestore(archived, byAdmin, true).toStatus).toBe('PUBLISHED');
    expect(() => planRestore(live, byOwner, true)).toThrow(InvalidStateTransition);
  });

  it('derives the revision state from the pointers and its decision', () => {
    expect(revisionState(liveUpdate, 'r2', null)).toBe('PENDING');
    expect(revisionState(liveUpdate, 'r1', 'APPROVE')).toBe('LIVE');
    expect(revisionState(live, 'r0', 'APPROVE')).toBe('SUPERSEDED');
    expect(revisionState(live, 'r3', 'REJECT')).toBe('REJECTED');
    expect(revisionState(live, 'r4', 'WITHDRAW')).toBe('WITHDRAWN');
    expect(() => revisionState(live, 'r5', null)).toThrow();
  });
});
