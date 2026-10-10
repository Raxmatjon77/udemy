import { ErrorCode } from '@udemy/contracts';
import { describe, expect, it } from 'vitest';
import {
  CourseInReview,
  CourseNotEditable,
  CoursePublishedCannotDelete,
  MarkdownNotAllowed,
  SlugFrozen,
  VersionConflict,
} from './catalog.errors';
import {
  assertDeletable,
  assertExpectedVersion,
  assertSlugEditable,
  assertWorkingCopyEditable,
  type CourseLifecycle,
  courseBadge,
  isWorkingCopyLocked,
} from './course';
import { assertMarkdownAllowed } from './markdown';

const draft: CourseLifecycle = {
  status: 'DRAFT',
  version: 3,
  pendingRevisionId: null,
  publishedRevisionId: null,
  firstPublishedAt: null,
};
const live: CourseLifecycle = {
  status: 'PUBLISHED',
  version: 9,
  pendingRevisionId: null,
  publishedRevisionId: 'r1',
  firstPublishedAt: new Date('2026-10-01T00:00:00Z'),
};

describe('working-copy rules (invariants 1, 2, 11)', () => {
  it('editable: DRAFT, REJECTED, PUBLISHED without a pending revision', () => {
    for (const course of [draft, { ...draft, status: 'REJECTED' as const }, live]) {
      expect(() => assertWorkingCopyEditable(course)).not.toThrow();
      expect(isWorkingCopyLocked(course)).toBe(false);
    }
  });

  it('pending revision -> course_in_review; archived -> course_not_editable', () => {
    const inReview = { ...draft, status: 'IN_REVIEW' as const, pendingRevisionId: 'r1' };
    const updatePending = { ...live, pendingRevisionId: 'r2' };
    expect(() => assertWorkingCopyEditable(inReview)).toThrow(CourseInReview);
    expect(() => assertWorkingCopyEditable(updatePending)).toThrow(CourseInReview);
    expect(() => assertWorkingCopyEditable({ ...live, status: 'ARCHIVED' })).toThrow(
      CourseNotEditable,
    );
    expect(isWorkingCopyLocked(updatePending)).toBe(true);
  });

  it('expectedVersion and slug freeze', () => {
    expect(() => assertExpectedVersion(draft, undefined)).not.toThrow();
    expect(() => assertExpectedVersion(draft, 3)).not.toThrow();
    expect(() => assertExpectedVersion(draft, 2)).toThrow(VersionConflict);
    expect(() => assertSlugEditable(draft)).not.toThrow();
    expect(() => assertSlugEditable(live)).toThrow(SlugFrozen);
  });

  it('delete: never-published and not in review only', () => {
    expect(() => assertDeletable(draft)).not.toThrow();
    expect(() => assertDeletable({ ...draft, status: 'REJECTED' })).not.toThrow();
    expect(() => assertDeletable(live)).toThrow(CoursePublishedCannotDelete);
    expect(() => assertDeletable({ ...live, status: 'ARCHIVED' })).toThrow(
      CoursePublishedCannotDelete,
    );
    expect(() =>
      assertDeletable({ ...draft, status: 'IN_REVIEW', pendingRevisionId: 'r1' }),
    ).toThrow(CourseInReview);
  });
});

describe('courseBadge', () => {
  it('derives the badge from status, the pending pointer and the head transition', () => {
    expect(courseBadge(draft, 'CREATE')).toBe('DRAFT');
    expect(courseBadge({ ...draft, status: 'IN_REVIEW', pendingRevisionId: 'r1' }, 'SUBMIT')).toBe(
      'IN_REVIEW',
    );
    expect(courseBadge({ ...draft, status: 'REJECTED' }, 'REJECT')).toBe('REJECTED');
    expect(courseBadge(live, 'APPROVE')).toBe('LIVE');
    expect(courseBadge({ ...live, pendingRevisionId: 'r2' }, 'SUBMIT')).toBe('LIVE_UPDATE_PENDING');
    expect(courseBadge(live, 'REJECT')).toBe('LIVE_UPDATE_REJECTED');
    // a later transition clears the rejected-update badge
    expect(courseBadge(live, 'WITHDRAW')).toBe('LIVE');
    expect(courseBadge(live, 'RESTORE')).toBe('LIVE');
    expect(courseBadge({ ...live, status: 'ARCHIVED' }, 'ARCHIVE')).toBe('ARCHIVED');
    expect(courseBadge(live, null)).toBe('LIVE');
  });
});

describe('assertMarkdownAllowed (D14)', () => {
  it('accepts safe markdown and keeps it untouched', () => {
    expect(() =>
      assertMarkdownAllowed('bodyMd', '# Hi\n\n[ok](https://example.com)  \n'),
    ).not.toThrow();
  });

  it('rejects HTML, images and unsafe links with one issue per construct', () => {
    let error: unknown;
    try {
      assertMarkdownAllowed(
        'bodyMd',
        'Hello <script>alert(1)</script>\n\n![x](https://e.test/a.png)\n\n[x](javascript:alert(1))',
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MarkdownNotAllowed);
    const problem = error as MarkdownNotAllowed;
    expect(problem.code).toBe(ErrorCode.MarkdownNotAllowed);
    expect(problem.kind).toBe('validation');
    expect(problem.issues.length).toBeGreaterThanOrEqual(3);
    expect(problem.issues.every((i) => i.path === 'bodyMd')).toBe(true);
    expect(problem.issues.map((i) => i.message).join('\n')).toMatch(/raw_html/);
    expect(problem.issues.map((i) => i.message).join('\n')).toMatch(/image/);
    expect(problem.issues.map((i) => i.message).join('\n')).toMatch(/unsafe_link/);
  });
});
