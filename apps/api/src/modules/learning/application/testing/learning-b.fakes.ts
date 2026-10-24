import type {
  CertificateStatus,
  EventDefinition,
  EventPayloadInput,
  SignedUrl,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import type { IdentityFacade, UserSummary } from '../../../identity';
import { CertificatePresenter } from '../certificate.presenter';
import type { TimestampKeyset } from '../learning-cursor';
import { CertificateEventPublisher } from '../ports/certificate-event.publisher';
import { CertificatePdfStorage } from '../ports/certificate-pdf.storage';
import {
  type AdminCertificateTransitionResult,
  type CertificatePageRow,
  type CertificateRecord,
  CertificateRepository,
  type CertificateTransitionRecord,
} from '../ports/certificates.repository';
import {
  type NewNote,
  type NotePageRow,
  type NotePatch,
  type NoteRecord,
  NotesRepository,
} from '../ports/notes.repository';
import {
  type AttemptQuestionRecord,
  type AttemptSubmission,
  type NewQuizAttempt,
  type QuizAttemptPageRow,
  type QuizAttemptRecord,
  QuizAttemptRepository,
} from '../ports/quiz-attempts.repository';
import { QuizAttemptPresenter } from '../quiz-attempt.presenter';
import {
  AdminCertificateActionCommand,
  AdminListUserCertificatesQuery,
  GetMyCertificatePdfQuery,
  GetMyCertificateQuery,
  GetPublicCertificatePdfQuery,
  ListMyCertificatesQuery,
  VerifyCertificateQuery,
} from '../use-cases/certificates.use-cases';
import {
  CreateNoteCommand,
  DeleteNoteCommand,
  ListNotesQuery,
  UpdateNoteCommand,
} from '../use-cases/notes.use-cases';
import {
  GetQuizAttemptQuery,
  ListQuizAttemptsQuery,
  StartQuizAttemptCommand,
  SubmitQuizAttemptCommand,
} from '../use-cases/quiz-attempts.use-cases';
import {
  type FakeClock,
  type FakeQuizContent,
  type LearningHarness,
  learningHarness,
  OWNER,
  QUIZ,
  REVISION,
  STUDENT,
} from './learning.fakes';

/* Fakes of the P5-T11 ports, with the SQL semantics the use cases rely on. */

let sequence = 0;
/** A fresh uuidv7-shaped id (unique per process). */
export function nextId(): string {
  sequence += 1;
  return `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

/** A Date as SQL prints it for the keyset (UTC, microseconds). */
function exactText(at: Date): string {
  return at.toISOString().replace('Z', '000Z');
}

function before(row: { at: string; id: string }, after: TimestampKeyset | null): boolean {
  if (after === null) return true;
  return row.at < after.at || (row.at === after.at && row.id < after.id);
}

function newestFirst<T extends { at: string; id: string }>(a: T, b: T): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/* ------------------------------------------------------------------------------- notes */

export class FakeNotesRepository extends NotesRepository {
  readonly notes = new Map<string, NoteRecord>();
  capLocks = 0;

  constructor(private readonly clock: FakeClock) {
    super();
  }

  lockCapAndCount(_trx: Transaction<DB>, userId: string, courseId: string): Promise<number> {
    this.capLocks += 1;
    return Promise.resolve(
      [...this.notes.values()].filter((n) => n.userId === userId && n.courseId === courseId).length,
    );
  }

  insert(_trx: Transaction<DB>, note: NewNote): Promise<NoteRecord> {
    const at = new Date(this.clock.ms);
    const record: NoteRecord = { id: nextId(), ...note, createdAt: at, updatedAt: at };
    this.notes.set(record.id, record);
    return Promise.resolve(record);
  }

  findOwn(userId: string, noteId: string): Promise<NoteRecord | null> {
    const note = this.notes.get(noteId);
    return Promise.resolve(note !== undefined && note.userId === userId ? note : null);
  }

  update(userId: string, noteId: string, patch: NotePatch): Promise<NoteRecord | null> {
    const note = this.notes.get(noteId);
    if (note === undefined || note.userId !== userId) return Promise.resolve(null);
    const updated: NoteRecord = {
      ...note,
      ...(patch.bodyMd === undefined ? {} : { bodyMd: patch.bodyMd }),
      ...(patch.positionSeconds === undefined ? {} : { positionSeconds: patch.positionSeconds }),
      updatedAt: new Date(this.clock.ms),
    };
    this.notes.set(noteId, updated);
    return Promise.resolve(updated);
  }

  delete(userId: string, noteId: string): Promise<boolean> {
    const note = this.notes.get(noteId);
    if (note === undefined || note.userId !== userId) return Promise.resolve(false);
    this.notes.delete(noteId);
    return Promise.resolve(true);
  }

  listPage(input: {
    readonly userId: string;
    readonly courseId: string;
    readonly lectureId: string | null;
    readonly after: TimestampKeyset | null;
    readonly limit: number;
  }): Promise<NotePageRow[]> {
    const rows = [...this.notes.values()]
      .filter(
        (n) =>
          n.userId === input.userId &&
          n.courseId === input.courseId &&
          (input.lectureId === null || n.lectureId === input.lectureId),
      )
      .map((note) => ({ note, at: exactText(note.createdAt), id: note.id }))
      .sort(newestFirst)
      .filter((row) => before(row, input.after))
      .slice(0, input.limit);
    return Promise.resolve(rows.map((r) => ({ note: r.note, keyset: { at: r.at, id: r.id } })));
  }

  ownerOf(noteId: string): Promise<string | null> {
    return Promise.resolve(this.notes.get(noteId)?.userId ?? null);
  }
}

/* ------------------------------------------------------------------------ quiz attempts */

type MutableAttempt = { -readonly [K in keyof QuizAttemptRecord]: QuizAttemptRecord[K] };

export class FakeQuizAttemptRepository extends QuizAttemptRepository {
  readonly attempts = new Map<string, MutableAttempt>();
  readonly questions = new Map<string, AttemptQuestionRecord[]>();
  readonly selections = new Map<string, Map<string, number[]>>();

  constructor(private readonly clock: FakeClock) {
    super();
  }

  private snapshot(attempt: MutableAttempt): QuizAttemptRecord {
    return { ...attempt };
  }

  lockOpen(
    _trx: Transaction<DB>,
    userId: string,
    lectureId: string,
  ): Promise<QuizAttemptRecord | null> {
    const open = [...this.attempts.values()].find(
      (a) => a.userId === userId && a.lectureId === lectureId && a.status === 'IN_PROGRESS',
    );
    return Promise.resolve(open === undefined ? null : this.snapshot(open));
  }

  abandon(_trx: Transaction<DB>, attemptId: string): Promise<boolean> {
    const attempt = this.attempts.get(attemptId);
    if (attempt === undefined || attempt.status !== 'IN_PROGRESS') return Promise.resolve(false);
    attempt.status = 'ABANDONED';
    attempt.abandonedAt = new Date(this.clock.ms);
    return Promise.resolve(true);
  }

  async insert(trx: Transaction<DB>, input: NewQuizAttempt): Promise<QuizAttemptRecord | null> {
    if ((await this.lockOpen(trx, input.userId, input.lectureId)) !== null) return null;
    const attempt: MutableAttempt = {
      id: nextId(),
      userId: input.userId,
      courseId: input.courseId,
      lectureId: input.lectureId,
      revisionId: input.revisionId,
      status: 'IN_PROGRESS',
      passPct: input.passPct,
      questionCount: input.questionIds.length,
      correctCount: null,
      scorePct: null,
      passed: null,
      startedAt: new Date(this.clock.ms),
      submittedAt: null,
      abandonedAt: null,
    };
    this.attempts.set(attempt.id, attempt);
    this.questions.set(
      attempt.id,
      input.questionIds.map((questionId, position) => ({
        questionId,
        position,
        isCorrect: null,
      })),
    );
    return this.snapshot(attempt);
  }

  findOwn(
    userId: string,
    attemptId: string,
    _options?: { readonly ex?: Executor; readonly forUpdate?: boolean },
  ): Promise<QuizAttemptRecord | null> {
    const attempt = this.attempts.get(attemptId);
    return Promise.resolve(
      attempt !== undefined && attempt.userId === userId ? this.snapshot(attempt) : null,
    );
  }

  listQuestions(attemptId: string): Promise<AttemptQuestionRecord[]> {
    return Promise.resolve([...(this.questions.get(attemptId) ?? [])]);
  }

  listSelections(attemptId: string): Promise<Map<string, number[]>> {
    return Promise.resolve(new Map(this.selections.get(attemptId) ?? []));
  }

  submit(_trx: Transaction<DB>, submission: AttemptSubmission): Promise<QuizAttemptRecord | null> {
    const attempt = this.attempts.get(submission.attemptId);
    if (attempt === undefined || attempt.status !== 'IN_PROGRESS') return Promise.resolve(null);
    const grades = new Map(submission.graded.map((g) => [g.questionId, g.isCorrect]));
    this.questions.set(
      attempt.id,
      (this.questions.get(attempt.id) ?? []).map((q) => ({
        ...q,
        isCorrect: grades.get(q.questionId) ?? null,
      })),
    );
    this.selections.set(
      attempt.id,
      new Map([...submission.selections].map(([id, positions]) => [id, [...positions]])),
    );
    // The generated columns: round(correct * 100.0 / total), passed = score >= pass_pct.
    const scorePct = Math.round((submission.correctCount * 100) / attempt.questionCount);
    attempt.status = 'SUBMITTED';
    attempt.correctCount = submission.correctCount;
    attempt.scorePct = scorePct;
    attempt.passed = scorePct >= attempt.passPct;
    attempt.submittedAt = new Date(this.clock.ms);
    return Promise.resolve(this.snapshot(attempt));
  }

  listPage(input: {
    readonly userId: string;
    readonly lectureId: string;
    readonly after: TimestampKeyset | null;
    readonly limit: number;
  }): Promise<QuizAttemptPageRow[]> {
    const rows = [...this.attempts.values()]
      .filter((a) => a.userId === input.userId && a.lectureId === input.lectureId)
      .map((a) => ({ attempt: this.snapshot(a), at: exactText(a.startedAt), id: a.id }))
      .sort(newestFirst)
      .filter((row) => before(row, input.after))
      .slice(0, input.limit);
    return Promise.resolve(
      rows.map((r) => ({ attempt: r.attempt, keyset: { at: r.at, id: r.id } })),
    );
  }

  ownerOf(attemptId: string): Promise<string | null> {
    return Promise.resolve(this.attempts.get(attemptId)?.userId ?? null);
  }
}

/* ------------------------------------------------------------------------- certificates */

export class FakeCertificateRepository extends CertificateRepository {
  readonly certificates = new Map<string, CertificateRecord>();
  readonly transitions: CertificateTransitionRecord[] = [];
  readonly completionLocks: string[] = [];

  constructor(private readonly clock: FakeClock) {
    super();
  }

  /** The worker's ISSUE (seq 1), optionally with a rendered PDF. */
  issue(input: {
    userId: string;
    courseId: string;
    code: string;
    pdfReady?: boolean;
    status?: CertificateStatus;
  }): CertificateRecord {
    const id = nextId();
    const at = new Date(this.clock.ms);
    const record: CertificateRecord = {
      id,
      code: input.code,
      userId: input.userId,
      courseId: input.courseId,
      recipientName: 'Sam Student',
      courseTitle: 'TypeScript from scratch',
      instructorName: 'Ada Instructor',
      status: input.status ?? 'ACTIVE',
      issuedAt: at,
      revokedAt: input.status === 'REVOKED' ? at : null,
      pdfObjectKey: input.pdfReady === false ? null : `certificates/${id}/v1.pdf`,
    };
    this.certificates.set(id, record);
    this.transitions.push({
      certificateId: id,
      seq: 1,
      action: 'ISSUE',
      cause: 'COURSE_COMPLETED',
      actorId: null,
      reason: null,
      occurredAt: at,
    });
    if (input.status === 'REVOKED') {
      this.transitions.push({
        certificateId: id,
        seq: 2,
        action: 'REVOKE',
        cause: 'ENROLLMENT_REVOKED',
        actorId: null,
        reason: null,
        occurredAt: at,
      });
    }
    return record;
  }

  listOwnPage(input: {
    readonly userId: string;
    readonly after: TimestampKeyset | null;
    readonly limit: number;
  }): Promise<CertificatePageRow[]> {
    const rows = [...this.certificates.values()]
      .filter((c) => c.userId === input.userId)
      .map((certificate) => ({
        certificate,
        at: exactText(certificate.issuedAt),
        id: certificate.id,
      }))
      .sort(newestFirst)
      .filter((row) => before(row, input.after))
      .slice(0, input.limit);
    return Promise.resolve(
      rows.map((r) => ({ certificate: r.certificate, keyset: { at: r.at, id: r.id } })),
    );
  }

  findOwn(userId: string, certificateId: string): Promise<CertificateRecord | null> {
    const c = this.certificates.get(certificateId);
    return Promise.resolve(c !== undefined && c.userId === userId ? c : null);
  }

  findById(certificateId: string): Promise<CertificateRecord | null> {
    return Promise.resolve(this.certificates.get(certificateId) ?? null);
  }

  findByCode(code: string): Promise<CertificateRecord | null> {
    return Promise.resolve([...this.certificates.values()].find((c) => c.code === code) ?? null);
  }

  listByUser(userId: string): Promise<CertificateRecord[]> {
    return Promise.resolve(
      [...this.certificates.values()]
        .filter((c) => c.userId === userId)
        .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime()),
    );
  }

  listTransitions(certificateIds: readonly string[]): Promise<CertificateTransitionRecord[]> {
    const ids = new Set(certificateIds);
    return Promise.resolve(this.transitions.filter((t) => ids.has(t.certificateId)));
  }

  lockCompletion(_trx: Transaction<DB>, userId: string, courseId: string): Promise<void> {
    this.completionLocks.push(`${userId}:${courseId}`);
    return Promise.resolve();
  }

  /** `transitionCertificate` with cause ADMIN (status materialised from the log). */
  transitionAsAdmin(
    _trx: Transaction<DB>,
    input: {
      readonly certificateId: string;
      readonly action: 'REVOKE' | 'REINSTATE';
      readonly actorId: string;
      readonly reason: string;
    },
  ): Promise<AdminCertificateTransitionResult> {
    const current = this.certificates.get(input.certificateId);
    if (current === undefined) return Promise.resolve({ outcome: 'NOT_FOUND' });
    const target: CertificateStatus = input.action === 'REVOKE' ? 'REVOKED' : 'ACTIVE';
    if (current.status === target) return Promise.resolve({ outcome: 'NOOP' });
    const occurredAt = new Date(this.clock.ms);
    const seq = this.transitions.filter((t) => t.certificateId === current.id).length + 1;
    this.transitions.push({
      certificateId: current.id,
      seq,
      action: input.action,
      cause: 'ADMIN',
      actorId: input.actorId,
      reason: input.reason,
      occurredAt,
    });
    this.certificates.set(current.id, {
      ...current,
      status: target,
      revokedAt: target === 'REVOKED' ? occurredAt : null,
    });
    return Promise.resolve({ outcome: 'APPLIED', occurredAt });
  }

  ownerOf(certificateId: string): Promise<string | null> {
    return Promise.resolve(this.certificates.get(certificateId)?.userId ?? null);
  }
}

export class FakePdfStorage extends CertificatePdfStorage {
  readonly signed: { objectKey: string; downloadName: string }[] = [];

  presignDownload(input: {
    readonly objectKey: string;
    readonly downloadName: string;
  }): Promise<SignedUrl> {
    this.signed.push({ ...input });
    return Promise.resolve({
      url: `https://media.test/${input.objectKey}?X-Amz-Signature=fake`,
      expiresAt: '2026-10-24T12:15:00.000Z',
    });
  }
}

export interface RecordedCertificateEvent {
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

export class RecordingCertificateEventPublisher extends CertificateEventPublisher {
  readonly events: RecordedCertificateEvent[] = [];

  publish<TDef extends EventDefinition>(
    _trx: Transaction<DB>,
    event: TDef,
    payload: EventPayloadInput<TDef> & { readonly certificateId: string },
  ): Promise<void> {
    const parsed = event.safeParsePayload(payload);
    if (!parsed.success) throw new Error(`invalid ${event.qualifiedType} payload`);
    this.events.push({
      type: event.type,
      aggregateId: payload.certificateId,
      payload: payload as unknown as Record<string, unknown>,
    });
    return Promise.resolve();
  }
}

export const ADMIN = '01900000-0000-7000-8000-00000000ad01';

export class FakeIdentity {
  readonly users = new Map<string, UserSummary>();

  constructor() {
    for (const [id, displayName] of [
      [STUDENT, 'Sam Student'],
      [OWNER, 'Ada Instructor'],
      [ADMIN, 'Alex Admin'],
    ] as const) {
      this.users.set(id, {
        id,
        email: `${displayName.split(' ')[0]!.toLowerCase()}@example.test`,
        displayName,
        emailVerified: true,
        status: 'ACTIVE',
        createdAt: new Date(0),
      });
    }
  }

  getUserSummary(userId: string): Promise<UserSummary | null> {
    return Promise.resolve(this.users.get(userId) ?? null);
  }

  getUserSummaries(userIds: readonly string[]): Promise<UserSummary[]> {
    return Promise.resolve(userIds.flatMap((id) => this.users.get(id) ?? []));
  }

  asFacade(): IdentityFacade {
    return this as unknown as IdentityFacade;
  }
}

/* -------------------------------------------------------------------------- the quiz */

export const Q1 = '01900000-0000-7000-8000-0000000c0001';
export const Q2 = '01900000-0000-7000-8000-0000000c0002';
export const Q3 = '01900000-0000-7000-8000-0000000c0003';
export const EXPLANATION = 'SECRET-EXPLANATION';

/**
 * Three questions, pass mark 70 (so 3/3 = 100 passes and 2/3 = 67 fails): Q1 single (correct 1
 * of 3), Q2 multiple (correct 0 and 2 of 4), Q3 single (correct 0 of 2).
 */
export const QUIZ_CONTENT: FakeQuizContent = {
  passPct: 70,
  questions: [
    {
      id: Q1,
      kind: 'SINGLE_CHOICE',
      promptMd: 'Pick B',
      explanationMd: `${EXPLANATION} 1`,
      options: [
        { text: 'A', isCorrect: false },
        { text: 'B', isCorrect: true },
        { text: 'C', isCorrect: false },
      ],
    },
    {
      id: Q2,
      kind: 'MULTIPLE_CHOICE',
      promptMd: 'Pick A and C',
      explanationMd: `${EXPLANATION} 2`,
      options: [
        { text: 'A', isCorrect: true },
        { text: 'B', isCorrect: false },
        { text: 'C', isCorrect: true },
        { text: 'D', isCorrect: false },
      ],
    },
    {
      id: Q3,
      kind: 'SINGLE_CHOICE',
      promptMd: 'True?',
      explanationMd: null,
      options: [
        { text: 'True', isCorrect: true },
        { text: 'False', isCorrect: false },
      ],
    },
  ],
};

export const ALL_CORRECT = [
  { questionId: Q1, optionPositions: [1] },
  { questionId: Q2, optionPositions: [2, 0] },
  { questionId: Q3, optionPositions: [0] },
];

export const TWO_OF_THREE = [
  { questionId: Q1, optionPositions: [1] },
  { questionId: Q2, optionPositions: [0] },
  { questionId: Q3, optionPositions: [0] },
];

/** The learning A harness plus every P5-T11 use case, wired with fakes. */
export function learningBHarness(options: Parameters<typeof learningHarness>[0] = {}) {
  const base: LearningHarness = learningHarness(options);
  base.catalog.setQuiz(REVISION, QUIZ, QUIZ_CONTENT);
  const notes = new FakeNotesRepository(base.clock);
  const attempts = new FakeQuizAttemptRepository(base.clock);
  const certificates = new FakeCertificateRepository(base.clock);
  const pdfStorage = new FakePdfStorage();
  const certificateEvents = new RecordingCertificateEventPublisher();
  const identity = new FakeIdentity();
  const catalog = base.catalog.asFacade();
  const quizPresenter = new QuizAttemptPresenter(catalog, attempts);
  const certificatePresenter = new CertificatePresenter(catalog, identity.asFacade(), certificates);
  return {
    ...base,
    notes,
    attempts,
    certificates,
    pdfStorage,
    certificateEvents,
    identity,
    quizPresenter,
    listNotes: new ListNotesQuery(base.access, notes),
    createNote: new CreateNoteCommand(base.rateLimiter, base.access, notes, base.tx),
    updateNote: new UpdateNoteCommand(base.rateLimiter, catalog, notes),
    deleteNote: new DeleteNoteCommand(base.rateLimiter, notes),
    startAttempt: new StartQuizAttemptCommand(
      base.rateLimiter,
      base.access,
      catalog,
      attempts,
      quizPresenter,
      base.tx,
    ),
    listAttempts: new ListQuizAttemptsQuery(base.access, attempts),
    getAttempt: new GetQuizAttemptQuery(attempts, quizPresenter),
    submitAttempt: new SubmitQuizAttemptCommand(
      base.rateLimiter,
      base.access,
      catalog,
      attempts,
      quizPresenter,
      base.recorder,
      base.completions,
      base.events,
      base.tx,
    ),
    listMyCertificates: new ListMyCertificatesQuery(certificates, certificatePresenter),
    getMyCertificate: new GetMyCertificateQuery(certificates, certificatePresenter),
    getMyCertificatePdf: new GetMyCertificatePdfQuery(certificates, pdfStorage),
    verifyCertificate: new VerifyCertificateQuery(
      base.rateLimiter,
      certificates,
      certificatePresenter,
    ),
    publicCertificatePdf: new GetPublicCertificatePdfQuery(
      base.rateLimiter,
      certificates,
      pdfStorage,
    ),
    adminListCertificates: new AdminListUserCertificatesQuery(
      identity.asFacade(),
      certificates,
      certificatePresenter,
    ),
    adminCertificateAction: new AdminCertificateActionCommand(
      certificates,
      certificateEvents,
      certificatePresenter,
      base.tx,
    ),
  };
}

export type LearningBHarness = ReturnType<typeof learningBHarness>;
