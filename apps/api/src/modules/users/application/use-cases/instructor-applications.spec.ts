import { describe, expect, it } from 'vitest';
import { AccountNotFound } from '../../../identity';
import {
  AlreadyInstructor,
  ApplicantBanned,
  ApplicationAlreadyPending,
  EmailNotVerified,
  InstructorApplicationNotFound,
  InvalidStateTransition,
  InvalidUsersField,
  SelfDecisionForbidden,
  VersionConflict,
} from '../../domain/users.errors';
import { encodeApplicationCursor } from '../application-cursor';
import {
  createUsersHarness,
  principalOf,
  REJECTION_REASON,
  VALID_FORM,
} from '../testing/users.harness';
import { APPROVAL_GRANT_REASON } from './approve-instructor-application.command';

describe('SubmitInstructorApplication', () => {
  it('creates a PENDING application with its submission transition and the outbox event, in one transaction', async () => {
    const h = createUsersHarness();
    const student = h.identity.add();

    const app = await h.submit.execute({ applicantId: student.id, form: VALID_FORM });

    expect(app).toMatchObject({
      applicantId: student.id,
      status: 'PENDING',
      version: 1,
      expertise: 'TypeScript',
      portfolioUrl: null,
      transitions: [{ fromStatus: null, toStatus: 'PENDING', actorId: student.id, reason: null }],
    });
    expect(h.events.events).toEqual([
      {
        type: 'submitted',
        payload: { applicationId: app.id, applicantId: student.id, submittedAt: app.submittedAt },
      },
    ]);
    expect(h.tx.runs).toBe(1);
  });

  it('requires a verified email, checked fresh (403 email_not_verified)', async () => {
    const h = createUsersHarness();
    const student = h.identity.add({ emailVerified: false });
    await expect(h.submit.execute({ applicantId: student.id, form: VALID_FORM })).rejects.toThrow(
      EmailNotVerified,
    );
    expect(h.events.events).toEqual([]);
  });

  it('refuses banned accounts (403 account_banned)', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    const student = h.identity.add();
    await h.identity.banUser({} as never, {
      userId: student.id,
      actorId: admin.id,
      reason: 'spam spam spam',
    });

    const error = await h.submit
      .execute({ applicantId: student.id, form: VALID_FORM })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplicantBanned);
    expect((error as ApplicantBanned).code).toBe('account_banned');
  });

  it('refuses instructors (409 already_instructor)', async () => {
    const h = createUsersHarness();
    const student = h.identity.add();
    h.access.give(student.id, 'INSTRUCTOR');
    await expect(h.submit.execute({ applicantId: student.id, form: VALID_FORM })).rejects.toThrow(
      AlreadyInstructor,
    );
  });

  it('allows one PENDING application at a time (409 application_already_pending)', async () => {
    const h = createUsersHarness();
    const student = h.identity.add();
    await h.submit.execute({ applicantId: student.id, form: VALID_FORM });
    await expect(h.submit.execute({ applicantId: student.id, form: VALID_FORM })).rejects.toThrow(
      ApplicationAlreadyPending,
    );
  });

  it('allows re-applying after a rejection or withdrawal (a new aggregate)', async () => {
    const h = createUsersHarness();
    const student = h.identity.add();
    h.applications.seed(student.id, { status: 'REJECTED', version: 2 });
    h.applications.seed(student.id, { status: 'WITHDRAWN', version: 2 });
    await expect(
      h.submit.execute({ applicantId: student.id, form: VALID_FORM }),
    ).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('validates the form before opening a transaction (422)', async () => {
    const h = createUsersHarness();
    const student = h.identity.add();
    await expect(
      h.submit.execute({ applicantId: student.id, form: { ...VALID_FORM, motivation: 'short' } }),
    ).rejects.toThrow(InvalidUsersField);
    expect(h.tx.runs).toBe(0);
  });

  it('is 404 for an unknown account', async () => {
    const h = createUsersHarness();
    await expect(
      h.submit.execute({ applicantId: crypto.randomUUID(), form: VALID_FORM }),
    ).rejects.toThrow(AccountNotFound);
  });
});

describe('WithdrawInstructorApplication', () => {
  it('moves PENDING -> WITHDRAWN and emits InstructorApplicationWithdrawn', async () => {
    const h = createUsersHarness();
    const student = h.identity.add();
    const pending = h.applications.seed(student.id);

    const app = await h.withdraw.execute({ actorId: student.id, applicationId: pending.id });

    expect(app.status).toBe('WITHDRAWN');
    expect(app.version).toBe(2);
    expect(app.transitions.at(-1)).toMatchObject({
      fromStatus: 'PENDING',
      toStatus: 'WITHDRAWN',
      actorId: student.id,
    });
    expect(h.events.events).toEqual([
      {
        type: 'withdrawn',
        payload: {
          applicationId: pending.id,
          applicantId: student.id,
          withdrawnAt: app.transitions.at(-1)?.occurredAt,
        },
      },
    ]);
  });

  it("is 404 for another user's application and for unknown ids", async () => {
    const h = createUsersHarness();
    const pending = h.applications.seed(h.identity.add().id);
    await expect(
      h.withdraw.execute({ actorId: h.identity.add().id, applicationId: pending.id }),
    ).rejects.toThrow(InstructorApplicationNotFound);
    await expect(
      h.withdraw.execute({ actorId: pending.applicantId, applicationId: crypto.randomUUID() }),
    ).rejects.toThrow(InstructorApplicationNotFound);
  });

  it('is 409 once decided', async () => {
    const h = createUsersHarness();
    const student = h.identity.add();
    const approved = h.applications.seed(student.id, { status: 'APPROVED', version: 2 });
    await expect(
      h.withdraw.execute({ actorId: student.id, applicationId: approved.id }),
    ).rejects.toThrow(InvalidStateTransition);
  });
});

describe('ApproveInstructorApplication', () => {
  it('approves, grants INSTRUCTOR with the application as source and emits the event', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    const student = h.identity.add();
    const pending = h.applications.seed(student.id);

    const app = await h.approve.execute({
      actorId: admin.id,
      applicationId: pending.id,
      note: 'Welcome!',
      expectedVersion: 1,
    });

    expect(app).toMatchObject({ status: 'APPROVED', version: 2 });
    expect(app.transitions.at(-1)).toMatchObject({
      fromStatus: 'PENDING',
      toStatus: 'APPROVED',
      actorId: admin.id,
      reason: 'Welcome!',
    });
    expect(h.access.grants).toEqual([
      {
        userId: student.id,
        role: 'INSTRUCTOR',
        actorId: admin.id,
        reason: APPROVAL_GRANT_REASON,
        source: { type: 'instructor_application', id: pending.id },
      },
    ]);
    expect(h.events.events).toEqual([
      {
        type: 'approved',
        payload: {
          applicationId: pending.id,
          applicantId: student.id,
          decidedBy: admin.id,
          decidedAt: app.transitions.at(-1)?.occurredAt,
        },
      },
    ]);
    expect(h.tx.runs).toBe(1);
  });

  it('a second approve is 409 invalid_state_transition and grants nothing', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    const pending = h.applications.seed(h.identity.add().id);
    await h.approve.execute({ actorId: admin.id, applicationId: pending.id });

    await expect(
      h.approve.execute({ actorId: admin.id, applicationId: pending.id }),
    ).rejects.toThrow(InvalidStateTransition);
    expect(h.access.grants).toHaveLength(1);
  });

  it('self-approval is 403 self_decision_forbidden', async () => {
    const h = createUsersHarness();
    const student = h.identity.add();
    const pending = h.applications.seed(student.id);
    await expect(
      h.approve.execute({ actorId: student.id, applicationId: pending.id }),
    ).rejects.toThrow(SelfDecisionForbidden);
    expect(h.access.grants).toEqual([]);
  });

  it('a stale expectedVersion is 409 version_conflict', async () => {
    const h = createUsersHarness();
    const pending = h.applications.seed(h.identity.add().id);
    await expect(
      h.approve.execute({
        actorId: h.identity.add().id,
        applicationId: pending.id,
        expectedVersion: 7,
      }),
    ).rejects.toThrow(VersionConflict);
  });

  it('losing a race in the conditional update is 409 and leaves no trace', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    const pending = h.applications.seed(h.identity.add().id);
    // Another admin rejects between our read and our UPDATE.
    h.applications.beforeApply = (id) => {
      const row = h.applications.rows.get(id);
      if (row !== undefined && row.status === 'PENDING') {
        row.status = 'REJECTED';
        row.version += 1;
      }
    };

    await expect(
      h.approve.execute({ actorId: admin.id, applicationId: pending.id }),
    ).rejects.toThrow(InvalidStateTransition);
    expect(h.access.grants).toEqual([]);
    expect(h.events.events).toEqual([]);
  });

  it('losing the race with an expectedVersion is 409 version_conflict', async () => {
    const h = createUsersHarness();
    const pending = h.applications.seed(h.identity.add().id);
    h.applications.beforeApply = (id) => {
      const row = h.applications.rows.get(id);
      if (row !== undefined) row.version += 1;
    };
    await expect(
      h.approve.execute({
        actorId: h.identity.add().id,
        applicationId: pending.id,
        expectedVersion: 1,
      }),
    ).rejects.toThrow(VersionConflict);
  });

  it('is 404 for an unknown application', async () => {
    const h = createUsersHarness();
    await expect(
      h.approve.execute({ actorId: h.identity.add().id, applicationId: crypto.randomUUID() }),
    ).rejects.toThrow(InstructorApplicationNotFound);
  });
});

describe('RejectInstructorApplication', () => {
  it('rejects with the reason and emits InstructorApplicationRejected (no grant)', async () => {
    const h = createUsersHarness();
    const admin = h.identity.add();
    const student = h.identity.add();
    const pending = h.applications.seed(student.id);

    const app = await h.reject.execute({
      actorId: admin.id,
      applicationId: pending.id,
      reason: REJECTION_REASON,
    });

    expect(app.status).toBe('REJECTED');
    expect(app.transitions.at(-1)).toMatchObject({
      toStatus: 'REJECTED',
      reason: REJECTION_REASON,
    });
    expect(h.access.grants).toEqual([]);
    expect(h.events.events).toEqual([
      {
        type: 'rejected',
        payload: {
          applicationId: pending.id,
          applicantId: student.id,
          decidedBy: admin.id,
          reason: REJECTION_REASON,
          decidedAt: app.transitions.at(-1)?.occurredAt,
        },
      },
    ]);
  });

  it('needs a 10–1000 character reason (422)', async () => {
    const h = createUsersHarness();
    const pending = h.applications.seed(h.identity.add().id);
    await expect(
      h.reject.execute({ actorId: h.identity.add().id, applicationId: pending.id, reason: 'no' }),
    ).rejects.toThrow(InvalidUsersField);
  });

  it('is forbidden to the applicant and 409 once decided', async () => {
    const h = createUsersHarness();
    const student = h.identity.add();
    const pending = h.applications.seed(student.id);
    await expect(
      h.reject.execute({
        actorId: student.id,
        applicationId: pending.id,
        reason: REJECTION_REASON,
      }),
    ).rejects.toThrow(SelfDecisionForbidden);

    const withdrawn = h.applications.seed(student.id, { status: 'WITHDRAWN', version: 2 });
    await expect(
      h.reject.execute({
        actorId: h.identity.add().id,
        applicationId: withdrawn.id,
        reason: REJECTION_REASON,
      }),
    ).rejects.toThrow(InvalidStateTransition);
  });
});

describe('ListMyInstructorApplications', () => {
  it('lists only my applications, newest first', async () => {
    const h = createUsersHarness();
    const me = h.identity.add();
    const older = h.applications.seed(me.id, { status: 'REJECTED', version: 2 });
    const newer = h.applications.seed(me.id);
    h.applications.seed(h.identity.add().id);

    const { items } = await h.listMine.execute(me.id);
    expect(items.map((a) => a.id)).toEqual([newer.id, older.id]);
  });
});

describe('GetInstructorApplication', () => {
  it('returns the application with the applicant summary to its applicant', async () => {
    const h = createUsersHarness();
    const me = h.identity.add({ displayName: 'Jane' });
    const pending = h.applications.seed(me.id);

    const detail = await h.getApplication.execute({
      principal: principalOf(me.id, { permissions: ['instructor_application:read:own'] }),
      applicationId: pending.id,
    });
    expect(detail).toMatchObject({
      id: pending.id,
      applicant: { id: me.id, displayName: 'Jane', emailVerified: true, status: 'ACTIVE' },
    });
  });

  it('returns any application to a holder of :any, and 404 to other users', async () => {
    const h = createUsersHarness();
    const pending = h.applications.seed(h.identity.add().id);
    const admin = principalOf(h.identity.add().id, {
      app: 'admin',
      permissions: ['instructor_application:read:any'],
    });
    await expect(
      h.getApplication.execute({ principal: admin, applicationId: pending.id }),
    ).resolves.toMatchObject({ id: pending.id });

    const stranger = principalOf(h.identity.add().id, {
      permissions: ['instructor_application:read:own'],
    });
    await expect(
      h.getApplication.execute({ principal: stranger, applicationId: pending.id }),
    ).rejects.toThrow(InstructorApplicationNotFound);
  });
});

describe('ListInstructorApplications (admin queue)', () => {
  it('pages PENDING applications oldest first with applicant summaries in one batch call', async () => {
    const h = createUsersHarness();
    const a = h.applications.seed(h.identity.add().id);
    const b = h.applications.seed(h.identity.add().id);
    const c = h.applications.seed(h.identity.add().id);
    h.applications.seed(h.identity.add().id, { status: 'APPROVED', version: 2 });

    const first = await h.listQueue.execute({ limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(first.items[0]?.applicant.id).toBe(a.applicantId);
    expect(first.nextCursor).not.toBeNull();
    expect(h.identity.calls.filter((call) => call === 'getUserSummaries')).toHaveLength(1);
    expect(h.identity.calls).not.toContain('getUserSummary');

    const second = await h.listQueue.execute({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((i) => i.id)).toEqual([c.id]);
    expect(second.nextCursor).toBeNull();
  });

  it('filters by status and decodes only its own cursors', async () => {
    const h = createUsersHarness();
    const approved = h.applications.seed(h.identity.add().id, { status: 'APPROVED', version: 2 });
    const page = await h.listQueue.execute({ status: 'APPROVED', limit: 20 });
    expect(page.items.map((i) => i.id)).toEqual([approved.id]);

    await expect(h.listQueue.execute({ limit: 20, cursor: 'Zm9v' })).rejects.toThrow(
      'Invalid cursor',
    );
    const foreign = encodeApplicationCursor({ submittedAt: 'yesterday', id: approved.id });
    await expect(h.listQueue.execute({ limit: 20, cursor: foreign })).rejects.toThrow(
      'Invalid cursor',
    );
    await expect(h.listQueue.execute({ limit: 101 })).rejects.toThrow('limit');
  });
});

describe('InstructorApplicationOwnership', () => {
  it('resolves the applicant, and null for unknown or malformed ids (404 before the param pipe)', async () => {
    const h = createUsersHarness();
    const pending = h.applications.seed('0199d0a0-0000-7000-8000-00000000000a');
    await expect(h.ownership.ownerOf(pending.id)).resolves.toBe(pending.applicantId);
    await expect(h.ownership.ownerOf(crypto.randomUUID())).resolves.toBeNull();
    await expect(h.ownership.ownerOf('not-a-uuid')).resolves.toBeNull();
  });
});
