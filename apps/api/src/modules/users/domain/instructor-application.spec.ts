import { describe, expect, it } from 'vitest';
import {
  type ApplicationStatus,
  InstructorApplication,
  type InstructorApplicationState,
} from './instructor-application';
import {
  InstructorApplicationNotFound,
  InvalidStateTransition,
  InvalidUsersField,
  SelfDecisionForbidden,
} from './users.errors';

const APPLICANT = '0199d0a0-0000-7000-8000-00000000000a';
const ADMIN = '0199d0a0-0000-7000-8000-00000000000b';
const OTHER = '0199d0a0-0000-7000-8000-00000000000c';
const APP_ID = '0199d0a0-0000-7000-8000-0000000000aa';

const FORM = {
  motivation: 'I have taught programming for ten years and want to share it. '.repeat(3),
  expertise: 'TypeScript, Node.js',
  experienceLevel: 'PROFESSIONAL',
  portfolioUrl: 'https://example.com/me',
};

function application(status: ApplicationStatus): InstructorApplication {
  const state: InstructorApplicationState = {
    id: APP_ID,
    applicantId: APPLICANT,
    status,
    motivation: FORM.motivation,
    expertise: FORM.expertise,
    experienceLevel: 'PROFESSIONAL',
    portfolioUrl: null,
    submittedAt: new Date('2026-10-10T10:00:00Z'),
    version: status === 'PENDING' ? 1 : 2,
    transitions: [],
  };
  return InstructorApplication.rehydrate(state);
}

const TERMINAL: ApplicationStatus[] = ['APPROVED', 'REJECTED', 'WITHDRAWN'];
const REASON = 'Not enough teaching experience yet.';

describe('InstructorApplication.submit', () => {
  it('returns the trimmed form and the submission transition (NULL -> PENDING by the applicant)', () => {
    const submission = InstructorApplication.submit(APPLICANT, {
      ...FORM,
      expertise: '  TypeScript  ',
    });
    expect(submission).toMatchObject({
      applicantId: APPLICANT,
      expertise: 'TypeScript',
      experienceLevel: 'PROFESSIONAL',
      portfolioUrl: 'https://example.com/me',
      transition: { fromStatus: null, toStatus: 'PENDING', actorId: APPLICANT, reason: null },
    });
  });

  it('treats a missing or blank portfolio URL as none', () => {
    expect(
      InstructorApplication.submit(APPLICANT, { ...FORM, portfolioUrl: undefined }).portfolioUrl,
    ).toBeNull();
    expect(
      InstructorApplication.submit(APPLICANT, { ...FORM, portfolioUrl: '  ' }).portfolioUrl,
    ).toBeNull();
  });

  it.each([
    ['motivation too short', { motivation: 'x'.repeat(99) }, 'motivation'],
    ['motivation too long', { motivation: 'x'.repeat(3001) }, 'motivation'],
    ['expertise too short', { expertise: 'ab' }, 'expertise'],
    ['expertise too long', { expertise: 'x'.repeat(201) }, 'expertise'],
    ['control characters', { expertise: 'Type\u0007Script' }, 'expertise'],
    ['unknown experience level', { experienceLevel: 'GURU' }, 'experienceLevel'],
    ['http portfolio', { portfolioUrl: 'http://example.com' }, 'portfolioUrl'],
    ['portfolio with spaces', { portfolioUrl: 'https://exa mple.com' }, 'portfolioUrl'],
    ['portfolio too long', { portfolioUrl: `https://e.com/${'a'.repeat(2048)}` }, 'portfolioUrl'],
  ])('rejects %s (422 on the field)', (_name, override, field) => {
    const submit = () => InstructorApplication.submit(APPLICANT, { ...FORM, ...override });
    expect(submit).toThrow(InvalidUsersField);
    try {
      submit();
    } catch (error) {
      expect((error as InvalidUsersField).issues[0]?.path).toBe(field);
    }
  });

  it('counts code points like char_length (100 emoji are 100 characters)', () => {
    expect(() =>
      InstructorApplication.submit(APPLICANT, { ...FORM, motivation: '😀'.repeat(100) }),
    ).not.toThrow();
  });
});

describe('InstructorApplication state machine', () => {
  describe('PENDING -> APPROVED', () => {
    it('is decided by an admin who is not the applicant', () => {
      expect(application('PENDING').approve(ADMIN)).toEqual({
        applicationId: APP_ID,
        applicantId: APPLICANT,
        fromStatus: 'PENDING',
        toStatus: 'APPROVED',
        actorId: ADMIN,
        reason: null,
      });
    });

    it('keeps an optional note as the transition reason', () => {
      expect(application('PENDING').approve(ADMIN, '  Welcome aboard  ').reason).toBe(
        'Welcome aboard',
      );
      expect(application('PENDING').approve(ADMIN, '   ').reason).toBeNull();
      expect(() => application('PENDING').approve(ADMIN, 'x'.repeat(1001))).toThrow(
        InvalidUsersField,
      );
    });

    it('is forbidden to the applicant (403 self_decision_forbidden)', () => {
      expect(() => application('PENDING').approve(APPLICANT)).toThrow(SelfDecisionForbidden);
    });
  });

  describe('PENDING -> REJECTED', () => {
    it('needs a 10–1000 character reason', () => {
      expect(application('PENDING').reject(ADMIN, `  ${REASON} `)).toMatchObject({
        toStatus: 'REJECTED',
        actorId: ADMIN,
        reason: REASON,
      });
      expect(() => application('PENDING').reject(ADMIN, 'too short')).toThrow(InvalidUsersField);
      expect(() => application('PENDING').reject(ADMIN, '')).toThrow(InvalidUsersField);
      expect(() => application('PENDING').reject(ADMIN, 'x'.repeat(1001))).toThrow(
        InvalidUsersField,
      );
    });

    it('is forbidden to the applicant', () => {
      expect(() => application('PENDING').reject(APPLICANT, REASON)).toThrow(SelfDecisionForbidden);
    });
  });

  describe('PENDING -> WITHDRAWN', () => {
    it('is done by the applicant, without a reason', () => {
      expect(application('PENDING').withdraw(APPLICANT)).toMatchObject({
        fromStatus: 'PENDING',
        toStatus: 'WITHDRAWN',
        actorId: APPLICANT,
        reason: null,
      });
    });

    it('is 404 for anybody else, admins included (no ID probing)', () => {
      expect(() => application('PENDING').withdraw(OTHER)).toThrow(InstructorApplicationNotFound);
      expect(() => application('PENDING').withdraw(ADMIN)).toThrow(InstructorApplicationNotFound);
    });
  });

  describe.each(TERMINAL)('%s is terminal', (status) => {
    it('cannot be approved', () => {
      expect(() => application(status).approve(ADMIN)).toThrow(InvalidStateTransition);
    });

    it('cannot be rejected', () => {
      expect(() => application(status).reject(ADMIN, REASON)).toThrow(InvalidStateTransition);
    });

    it('cannot be withdrawn', () => {
      expect(() => application(status).withdraw(APPLICANT)).toThrow(InvalidStateTransition);
    });

    it('reports itself as terminal', () => {
      expect(application(status).isTerminal()).toBe(true);
    });
  });

  it('checks the state before the actor: a decided application is 409 even for its applicant', () => {
    expect(() => application('APPROVED').approve(APPLICANT)).toThrow(InvalidStateTransition);
  });

  it('PENDING is not terminal', () => {
    expect(application('PENDING').isTerminal()).toBe(false);
  });
});
