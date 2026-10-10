import type { LectureType } from '@udemy/contracts';

/**
 * Who may consume a lecture's content (design §5 "Playback rules", §9 IDOR). Pure rules; the
 * application layer loads the facts (the lecture as stored in the live revision, the working
 * copy or a revision under review) and asks entitlements only when the rules need it.
 *
 * - `live` (public routes, optional Bearer): the lecture must be in the course's LIVE revision.
 *   Allowed for the owner, a moderator (`course:read:any`), anyone for a free preview (not for
 *   downloads), or an entitled user (`COURSE_ENTITLEMENTS`, deny-all until Phase 4). Otherwise
 *   403 `lecture_locked`: the outline of a live course is public, so existence is no secret.
 *   An ARCHIVED course is hidden (404) from everyone but the owner, moderators and entitled
 *   users (D13: its live revision stays watchable for enrolled students).
 * - `working` (the builder's preview of the unsaved working copy): the owner or a moderator
 *   (design §5/§8 `Pol course:read`); anyone else gets 404.
 * - `revision` (moderation): moderators only (the route requires `course:read:any`).
 */

/** What the caller wants to do with the lecture. */
export type LectureUse = 'stream' | 'article' | 'download';

/** The lecture type each use needs (`lecture_type_mismatch` otherwise). */
export const LECTURE_TYPE_FOR_USE: Readonly<Record<LectureUse, LectureType>> = {
  stream: 'VIDEO',
  article: 'ARTICLE',
  download: 'RESOURCE',
};

/** The authenticated end user, if any (public routes authenticate optionally). */
export interface PlaybackViewer {
  readonly userId: string;
  /** Holds `course:read:any` in the calling app (admin app only, D6). */
  readonly isModerator: boolean;
}

export interface LiveAccessFacts {
  readonly courseStatus: 'PUBLISHED' | 'ARCHIVED';
  readonly ownerId: string;
  /** The lecture id is part of the live revision. */
  readonly lectureInLiveRevision: boolean;
  readonly isPreview: boolean;
  readonly use: LectureUse;
  readonly viewer: PlaybackViewer | null;
  /** `CourseEntitlements.hasCourseAccess` of the viewer (false when anonymous). */
  readonly entitled: boolean;
}

export type LiveAccessDecision = 'ALLOW' | 'LOCKED' | 'COURSE_NOT_FOUND' | 'LECTURE_NOT_FOUND';

/** Owner or moderator: always allowed, without asking entitlements. */
export function isPrivilegedViewer(viewer: PlaybackViewer | null, ownerId: string): boolean {
  return viewer !== null && (viewer.isModerator || viewer.userId === ownerId);
}

/** Free previews unlock streaming and articles, never downloads (design §5). */
export function previewUnlocks(isPreview: boolean, use: LectureUse): boolean {
  return isPreview && use !== 'download';
}

export function decideLiveAccess(facts: LiveAccessFacts): LiveAccessDecision {
  const privileged = isPrivilegedViewer(facts.viewer, facts.ownerId);
  if (facts.courseStatus === 'ARCHIVED' && !privileged && !facts.entitled) {
    return 'COURSE_NOT_FOUND';
  }
  if (!facts.lectureInLiveRevision) return 'LECTURE_NOT_FOUND';
  if (privileged || previewUnlocks(facts.isPreview, facts.use) || facts.entitled) return 'ALLOW';
  return 'LOCKED';
}

/**
 * Whether the decision could still change with an entitlement: only then is the (Phase 4,
 * enrollment-backed) port worth a call.
 */
export function needsEntitlement(facts: Omit<LiveAccessFacts, 'entitled'>): boolean {
  if (facts.viewer === null) return false;
  const without = decideLiveAccess({ ...facts, entitled: false });
  return without === 'LOCKED' || without === 'COURSE_NOT_FOUND';
}

/** Working-copy preview: the owner or a moderator (design §5 `working`). */
export function canPreviewWorkingCopy(viewer: PlaybackViewer | null, ownerId: string): boolean {
  return isPrivilegedViewer(viewer, ownerId);
}

/** Revision playback: moderators only. */
export function canInspectRevision(viewer: PlaybackViewer | null): boolean {
  return viewer !== null && viewer.isModerator;
}
