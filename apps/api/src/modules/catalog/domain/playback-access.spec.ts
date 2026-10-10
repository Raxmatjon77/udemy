import { describe, expect, it } from 'vitest';
import {
  canInspectRevision,
  canPreviewWorkingCopy,
  decideLiveAccess,
  type LectureUse,
  type LiveAccessDecision,
  type LiveAccessFacts,
  needsEntitlement,
  type PlaybackViewer,
} from './playback-access';

const OWNER = 'owner-1';
const anonymous = null;
const student: PlaybackViewer = { userId: 'student-1', isModerator: false };
const owner: PlaybackViewer = { userId: OWNER, isModerator: false };
const otherInstructor: PlaybackViewer = { userId: 'instructor-2', isModerator: false };
const admin: PlaybackViewer = { userId: 'admin-1', isModerator: true };

function facts(overrides: Partial<LiveAccessFacts>): LiveAccessFacts {
  return {
    courseStatus: 'PUBLISHED',
    ownerId: OWNER,
    lectureInLiveRevision: true,
    isPreview: false,
    use: 'stream',
    viewer: anonymous,
    entitled: false,
    ...overrides,
  };
}

describe('decideLiveAccess (design §5 playback rules)', () => {
  type Row = [
    label: string,
    viewer: PlaybackViewer | null,
    isPreview: boolean,
    use: LectureUse,
    entitled: boolean,
    expected: LiveAccessDecision,
  ];
  const rows: Row[] = [
    ['anonymous, preview video', anonymous, true, 'stream', false, 'ALLOW'],
    ['anonymous, preview article', anonymous, true, 'article', false, 'ALLOW'],
    ['anonymous, locked video', anonymous, false, 'stream', false, 'LOCKED'],
    ['anonymous, preview does not unlock a download', anonymous, true, 'download', false, 'LOCKED'],
    ['student, locked video', student, false, 'stream', false, 'LOCKED'],
    ['student, entitled (Phase 4)', student, false, 'stream', true, 'ALLOW'],
    ['student, entitled download', student, false, 'download', true, 'ALLOW'],
    ['other instructor, locked video', otherInstructor, false, 'stream', false, 'LOCKED'],
    ['owner, locked video', owner, false, 'stream', false, 'ALLOW'],
    ['owner, download', owner, false, 'download', false, 'ALLOW'],
    ['admin, locked video', admin, false, 'stream', false, 'ALLOW'],
    ['admin, download', admin, false, 'download', false, 'ALLOW'],
  ];
  it.each(rows)('%s', (_label, viewer, isPreview, use, entitled, expected) => {
    expect(decideLiveAccess(facts({ viewer, isPreview, use, entitled }))).toBe(expected);
  });

  it('a lecture outside the live revision is not found, even for the owner or a preview', () => {
    for (const viewer of [anonymous, student, owner, admin]) {
      expect(
        decideLiveAccess(facts({ viewer, isPreview: true, lectureInLiveRevision: false })),
      ).toBe('LECTURE_NOT_FOUND');
    }
  });

  it('an archived course is hidden from the public, previews included', () => {
    for (const viewer of [anonymous, student, otherInstructor]) {
      expect(decideLiveAccess(facts({ courseStatus: 'ARCHIVED', viewer, isPreview: true }))).toBe(
        'COURSE_NOT_FOUND',
      );
    }
  });

  it('an archived course stays watchable for the owner, moderators and entitled users (D13)', () => {
    expect(decideLiveAccess(facts({ courseStatus: 'ARCHIVED', viewer: owner }))).toBe('ALLOW');
    expect(decideLiveAccess(facts({ courseStatus: 'ARCHIVED', viewer: admin }))).toBe('ALLOW');
    expect(
      decideLiveAccess(facts({ courseStatus: 'ARCHIVED', viewer: student, entitled: true })),
    ).toBe('ALLOW');
    // ... but its lectures must still be in the live revision
    expect(
      decideLiveAccess(
        facts({ courseStatus: 'ARCHIVED', viewer: owner, lectureInLiveRevision: false }),
      ),
    ).toBe('LECTURE_NOT_FOUND');
  });
});

describe('needsEntitlement', () => {
  const base = facts({});
  it('never for anonymous viewers, owners, moderators or free previews', () => {
    expect(needsEntitlement({ ...base, viewer: anonymous })).toBe(false);
    expect(needsEntitlement({ ...base, viewer: owner })).toBe(false);
    expect(needsEntitlement({ ...base, viewer: admin })).toBe(false);
    expect(needsEntitlement({ ...base, viewer: student, isPreview: true })).toBe(false);
    expect(needsEntitlement({ ...base, viewer: student, lectureInLiveRevision: false })).toBe(
      false,
    );
  });

  it('for a signed-in user on a locked lecture, a preview download or an archived course', () => {
    expect(needsEntitlement({ ...base, viewer: student })).toBe(true);
    expect(needsEntitlement({ ...base, viewer: student, isPreview: true, use: 'download' })).toBe(
      true,
    );
    expect(needsEntitlement({ ...base, viewer: student, courseStatus: 'ARCHIVED' })).toBe(true);
  });
});

describe('working copy and revision access', () => {
  it('working copy: owner or moderator only', () => {
    expect(canPreviewWorkingCopy(owner, OWNER)).toBe(true);
    expect(canPreviewWorkingCopy(admin, OWNER)).toBe(true);
    expect(canPreviewWorkingCopy(otherInstructor, OWNER)).toBe(false);
    expect(canPreviewWorkingCopy(student, OWNER)).toBe(false);
    expect(canPreviewWorkingCopy(anonymous, OWNER)).toBe(false);
  });

  it('revision: moderators only (not even the owner)', () => {
    expect(canInspectRevision(admin)).toBe(true);
    expect(canInspectRevision(owner)).toBe(false);
    expect(canInspectRevision(student)).toBe(false);
    expect(canInspectRevision(anonymous)).toBe(false);
  });
});
