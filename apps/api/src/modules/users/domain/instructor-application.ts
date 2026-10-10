import { parseText } from './text';
import {
  InstructorApplicationNotFound,
  InvalidStateTransition,
  InvalidUsersField,
  SelfDecisionForbidden,
} from './users.errors';

export const APPLICATION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export type TerminalStatus = Exclude<ApplicationStatus, 'PENDING'>;

export const EXPERIENCE_LEVELS = ['NONE', 'INFORMAL', 'PROFESSIONAL', 'ONLINE'] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export function isApplicationStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value);
}

export function isExperienceLevel(value: string): value is ExperienceLevel {
  return (EXPERIENCE_LEVELS as readonly string[]).includes(value);
}

/** Bounds of the columns' CHECK constraints (schema doc, `users.instructor_applications`). */
export const APPLICATION_RULES = {
  motivation: { field: 'motivation', min: 100, max: 3000, multiline: true },
  expertise: { field: 'expertise', min: 3, max: 200, multiline: true },
  rejectionReason: { field: 'reason', min: 10, max: 1000, multiline: true },
  approvalNote: { field: 'note', min: 1, max: 1000, multiline: true },
  portfolioUrlMax: 2048,
} as const;

const HTTPS_URL = /^https:\/\/\S+$/;

/** One row of the append-only transition log. `fromStatus` null = the submission. */
export interface ApplicationTransition {
  readonly fromStatus: ApplicationStatus | null;
  readonly toStatus: ApplicationStatus;
  readonly actorId: string;
  /** Rejection reason (required) or optional approval note; null otherwise. */
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export interface InstructorApplicationState {
  readonly id: string;
  readonly applicantId: string;
  readonly status: ApplicationStatus;
  readonly motivation: string;
  readonly expertise: string;
  readonly experienceLevel: ExperienceLevel;
  readonly portfolioUrl: string | null;
  readonly submittedAt: Date;
  readonly version: number;
  /** Oldest first. */
  readonly transitions: readonly ApplicationTransition[];
}

export interface ApplicationForm {
  readonly motivation: string;
  readonly expertise: string;
  readonly experienceLevel: string;
  readonly portfolioUrl?: string | null;
}

/** A validated new application: the row to insert plus its submission transition. */
export interface ApplicationSubmission {
  readonly applicantId: string;
  readonly motivation: string;
  readonly expertise: string;
  readonly experienceLevel: ExperienceLevel;
  readonly portfolioUrl: string | null;
  readonly transition: {
    readonly fromStatus: null;
    readonly toStatus: 'PENDING';
    readonly actorId: string;
    readonly reason: null;
  };
}

/**
 * A decided state change of a PENDING application, ready to be persisted with a conditional
 * `UPDATE ... WHERE status = 'PENDING'` (the DB re-checks it under the row lock).
 */
export interface ApplicationDecision {
  readonly applicationId: string;
  readonly applicantId: string;
  readonly fromStatus: 'PENDING';
  readonly toStatus: TerminalStatus;
  readonly actorId: string;
  readonly reason: string | null;
}

function parsePortfolioUrl(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > APPLICATION_RULES.portfolioUrlMax || !HTTPS_URL.test(value)) {
    throw new InvalidUsersField({
      path: 'portfolioUrl',
      message: `Must be an https:// URL of at most ${APPLICATION_RULES.portfolioUrlMax} characters.`,
    });
  }
  return value;
}

/**
 * Aggregate `InstructorApplication` (design §4):
 *
 *   [*] -> PENDING -> APPROVED | REJECTED | WITHDRAWN (all terminal)
 *
 * - only PENDING can transition, terminal states are final;
 * - REJECTED needs a reason (10–1000 chars), APPROVED may carry a note (1–1000);
 * - the decider (approve/reject) is never the applicant;
 * - only the applicant can withdraw.
 *
 * The cross-aggregate rules of a submission (verified email, not banned, not an instructor,
 * one PENDING per applicant) need other modules and the DB; the submit use case owns them.
 * The DB enforces the same machine (`ia_transitions_edge_ck`, the `_uq` constraints and the
 * `ia_transitions_actor_trg` trigger), so a race the snapshot cannot see still fails safely.
 */
export class InstructorApplication {
  private constructor(private readonly s: InstructorApplicationState) {}

  static rehydrate(state: InstructorApplicationState): InstructorApplication {
    return new InstructorApplication(state);
  }

  /**
   * Validates the form of a new application.
   * @throws InvalidUsersField (422)
   */
  static submit(applicantId: string, form: ApplicationForm): ApplicationSubmission {
    if (!isExperienceLevel(form.experienceLevel)) {
      throw new InvalidUsersField({
        path: 'experienceLevel',
        message: `Must be one of ${EXPERIENCE_LEVELS.join(', ')}.`,
      });
    }
    return {
      applicantId,
      motivation: parseText(form.motivation, APPLICATION_RULES.motivation),
      expertise: parseText(form.expertise, APPLICATION_RULES.expertise),
      experienceLevel: form.experienceLevel,
      portfolioUrl: parsePortfolioUrl(form.portfolioUrl),
      transition: { fromStatus: null, toStatus: 'PENDING', actorId: applicantId, reason: null },
    };
  }

  get id(): string {
    return this.s.id;
  }

  get applicantId(): string {
    return this.s.applicantId;
  }

  get status(): ApplicationStatus {
    return this.s.status;
  }

  get version(): number {
    return this.s.version;
  }

  get state(): InstructorApplicationState {
    return this.s;
  }

  isTerminal(): boolean {
    return this.s.status !== 'PENDING';
  }

  /**
   * PENDING -> APPROVED by an admin who is not the applicant.
   * @throws InvalidStateTransition (409), SelfDecisionForbidden (403), InvalidUsersField (422)
   */
  approve(actorId: string, note?: string | null): ApplicationDecision {
    this.assertPending('APPROVED');
    if (actorId === this.s.applicantId) throw new SelfDecisionForbidden();
    const reason =
      note === undefined || note === null || note.trim() === ''
        ? null
        : parseText(note, APPLICATION_RULES.approvalNote);
    return this.decision('APPROVED', actorId, reason);
  }

  /**
   * PENDING -> REJECTED by an admin who is not the applicant, with a 10–1000 char reason.
   * @throws InvalidStateTransition (409), SelfDecisionForbidden (403), InvalidUsersField (422)
   */
  reject(actorId: string, reason: string): ApplicationDecision {
    this.assertPending('REJECTED');
    if (actorId === this.s.applicantId) throw new SelfDecisionForbidden();
    return this.decision('REJECTED', actorId, parseText(reason, APPLICATION_RULES.rejectionReason));
  }

  /**
   * PENDING -> WITHDRAWN by the applicant. Anyone else gets 404, not 403 (no ID probing).
   * @throws InstructorApplicationNotFound (404), InvalidStateTransition (409)
   */
  withdraw(actorId: string): ApplicationDecision {
    if (actorId !== this.s.applicantId) throw new InstructorApplicationNotFound();
    this.assertPending('WITHDRAWN');
    return this.decision('WITHDRAWN', actorId, null);
  }

  private assertPending(to: TerminalStatus): void {
    if (this.s.status !== 'PENDING') {
      throw new InvalidStateTransition({ from: this.s.status, to });
    }
  }

  private decision(
    toStatus: TerminalStatus,
    actorId: string,
    reason: string | null,
  ): ApplicationDecision {
    return {
      applicationId: this.s.id,
      applicantId: this.s.applicantId,
      fromStatus: 'PENDING',
      toStatus,
      actorId,
      reason,
    };
  }
}
