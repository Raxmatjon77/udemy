import { describe, expect, it } from 'vitest';
import {
  AdminInstructorApplicationsQuerySchema,
  ApproveInstructorApplicationRequestSchema,
  InstructorApplicationDetailSchema,
  InstructorApplicationPageSchema,
  MyInstructorApplicationsResponseSchema,
  RejectInstructorApplicationRequestSchema,
  SubmitInstructorApplicationRequestSchema,
} from './instructor-applications';

const id = '0199c9a1-7d2e-7c4a-9b1e-3f5d2a6b8c01';
const at = '2026-10-10T12:00:00.000Z';
const form = {
  motivation: 'm'.repeat(100),
  expertise: 'TypeScript',
  experienceLevel: 'PROFESSIONAL',
  portfolioUrl: 'https://jane.dev/portfolio',
};

describe('SubmitInstructorApplicationRequestSchema', () => {
  const ok = (body: unknown) => SubmitInstructorApplicationRequestSchema.safeParse(body).success;

  it('accepts a valid form, with or without a portfolio', () => {
    expect(SubmitInstructorApplicationRequestSchema.parse(form)).toEqual(form);
    expect(ok({ ...form, portfolioUrl: undefined })).toBe(true);
  });

  it('bounds motivation to 100–3000 (after trimming)', () => {
    expect(ok({ ...form, motivation: 'm'.repeat(3000) })).toBe(true);
    expect(ok({ ...form, motivation: 'm'.repeat(99) })).toBe(false);
    expect(ok({ ...form, motivation: ` ${'m'.repeat(99)} ` })).toBe(false);
    expect(ok({ ...form, motivation: 'm'.repeat(3001) })).toBe(false);
  });

  it('bounds expertise to 3–200', () => {
    expect(ok({ ...form, expertise: 'Go!' })).toBe(true);
    expect(ok({ ...form, expertise: 'Go' })).toBe(false);
    expect(ok({ ...form, expertise: 'e'.repeat(201) })).toBe(false);
  });

  it('only accepts the experience levels', () => {
    for (const level of ['NONE', 'INFORMAL', 'PROFESSIONAL', 'ONLINE']) {
      expect(ok({ ...form, experienceLevel: level })).toBe(true);
    }
    expect(ok({ ...form, experienceLevel: 'EXPERT' })).toBe(false);
  });

  it('only accepts https portfolio URLs up to 2048 chars', () => {
    const base = 'https://example.com/';
    expect(ok({ ...form, portfolioUrl: base + 'p'.repeat(2048 - base.length) })).toBe(true);
    expect(ok({ ...form, portfolioUrl: base + 'p'.repeat(2049 - base.length) })).toBe(false);
    for (const url of [
      'http://example.com',
      'HTTPS://example.com',
      'https://exa mple.com',
      'https://localhost',
      'ftp://example.com',
      'javascript:alert(1)',
      '',
    ]) {
      expect(ok({ ...form, portfolioUrl: url }), url).toBe(false);
    }
  });
});

describe('decision bodies', () => {
  it('approve: optional note 1–1000 and expectedVersion ≥ 1', () => {
    const ok = (body: unknown) => ApproveInstructorApplicationRequestSchema.safeParse(body).success;
    expect(ok({})).toBe(true);
    expect(ok({ note: 'Welcome aboard', expectedVersion: 1 })).toBe(true);
    expect(ok({ note: '' })).toBe(false);
    expect(ok({ note: 'n'.repeat(1001) })).toBe(false);
    expect(ok({ expectedVersion: 0 })).toBe(false);
    expect(ok({ expectedVersion: 1.5 })).toBe(false);
  });

  it('reject: reason 10–1000 required', () => {
    const ok = (body: unknown) => RejectInstructorApplicationRequestSchema.safeParse(body).success;
    expect(ok({ reason: 'r'.repeat(10) })).toBe(true);
    expect(ok({ reason: 'r'.repeat(1000), expectedVersion: 3 })).toBe(true);
    expect(ok({ reason: 'r'.repeat(9) })).toBe(false);
    expect(ok({ reason: 'r'.repeat(1001) })).toBe(false);
    expect(ok({})).toBe(false);
  });
});

describe('AdminInstructorApplicationsQuerySchema', () => {
  it('defaults status to PENDING and limit to 20', () => {
    expect(AdminInstructorApplicationsQuerySchema.parse({})).toEqual({
      status: 'PENDING',
      limit: 20,
    });
    expect(AdminInstructorApplicationsQuerySchema.parse({ status: '', cursor: '' })).toEqual({
      status: 'PENDING',
      limit: 20,
    });
  });

  it('parses query strings and rejects bad values', () => {
    expect(
      AdminInstructorApplicationsQuerySchema.parse({
        status: 'APPROVED',
        limit: '100',
        cursor: 'abc_-1',
      }),
    ).toEqual({ status: 'APPROVED', limit: 100, cursor: 'abc_-1' });
    expect(AdminInstructorApplicationsQuerySchema.safeParse({ status: 'pending' }).success).toBe(
      false,
    );
    expect(AdminInstructorApplicationsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});

describe('application responses', () => {
  const application = {
    id,
    applicantId: id,
    status: 'REJECTED',
    motivation: form.motivation,
    expertise: form.expertise,
    experienceLevel: form.experienceLevel,
    portfolioUrl: null,
    submittedAt: at,
    version: 2,
    transitions: [
      { fromStatus: null, toStatus: 'PENDING', actorId: id, reason: null, occurredAt: at },
      {
        fromStatus: 'PENDING',
        toStatus: 'REJECTED',
        actorId: id,
        reason: 'Not enough detail',
        occurredAt: at,
      },
    ],
  };
  const applicant = {
    id,
    email: 'jane@example.com',
    displayName: 'Jane',
    emailVerified: true,
    status: 'ACTIVE',
  };

  it('accept valid examples', () => {
    expect(MyInstructorApplicationsResponseSchema.safeParse({ items: [application] }).success).toBe(
      true,
    );
    expect(InstructorApplicationDetailSchema.parse({ ...application, applicant })).toEqual({
      ...application,
      applicant,
    });
    expect(
      InstructorApplicationPageSchema.safeParse({
        items: [{ ...application, applicant }],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it('reject invalid examples', () => {
    expect(InstructorApplicationDetailSchema.safeParse(application).success).toBe(false);
    expect(
      MyInstructorApplicationsResponseSchema.safeParse({
        items: [{ ...application, status: 'DONE' }],
      }).success,
    ).toBe(false);
  });
});
