import { Injectable } from '@nestjs/common';
import { type DB, type Executor, sql, type Transaction } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import {
  type ApplicationKeyset,
  type ApplicationQueueFilter,
  type ApplicationQueueRow,
  type ApplyDecisionResult,
  InstructorApplicationRepository,
} from '../application/ports/instructor-application.repository';
import {
  type ApplicationDecision,
  type ApplicationStatus,
  type ApplicationSubmission,
  type ApplicationTransition,
  type ExperienceLevel,
  type InstructorApplicationState,
  isApplicationStatus,
  isExperienceLevel,
} from '../domain/instructor-application';
import { mapUsersConstraints } from './users-constraint-errors';

/** `submitted_at` as UTC ISO 8601 with microseconds (keyset cursors must not lose precision). */
const SUBMITTED_AT_TEXT = sql<string>`to_char(a.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const APPLICATION_COLUMNS = [
  'a.id',
  'a.applicantId',
  'a.status',
  'a.motivation',
  'a.expertise',
  'a.experienceLevel',
  'a.portfolioUrl',
  'a.submittedAt',
  'a.version',
] as const;

interface ApplicationRow {
  id: string;
  applicantId: string;
  status: string;
  motivation: string;
  expertise: string;
  experienceLevel: string;
  portfolioUrl: string | null;
  submittedAt: Date;
  version: number;
}

interface TransitionRow {
  applicationId: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string;
  reason: string | null;
  occurredAt: Date;
}

/** CHECK constraints guarantee these; anything else means the schema and code drifted. */
function status(value: string): ApplicationStatus {
  if (!isApplicationStatus(value)) throw new Error(`Unknown application status '${value}'`);
  return value;
}

function experienceLevel(value: string): ExperienceLevel {
  if (!isExperienceLevel(value)) throw new Error(`Unknown experience level '${value}'`);
  return value;
}

function toTransition(row: TransitionRow): ApplicationTransition {
  return {
    fromStatus: row.fromStatus === null ? null : status(row.fromStatus),
    toStatus: status(row.toStatus),
    actorId: row.actorId,
    reason: row.reason,
    occurredAt: row.occurredAt,
  };
}

function toState(
  row: ApplicationRow,
  transitions: readonly ApplicationTransition[],
): InstructorApplicationState {
  return {
    id: row.id,
    applicantId: row.applicantId,
    status: status(row.status),
    motivation: row.motivation,
    expertise: row.expertise,
    experienceLevel: experienceLevel(row.experienceLevel),
    portfolioUrl: row.portfolioUrl,
    submittedAt: row.submittedAt,
    version: row.version,
    transitions,
  };
}

@Injectable()
export class KyselyInstructorApplicationRepository extends InstructorApplicationRepository {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  async findById(id: string, ex: Executor = this.db): Promise<InstructorApplicationState | null> {
    const row = await ex
      .selectFrom('users.instructorApplications as a')
      .select(APPLICATION_COLUMNS)
      .where('a.id', '=', id)
      .executeTakeFirst();
    if (row === undefined) return null;
    const [state] = await this.withTransitions([row], ex);
    return state ?? null;
  }

  async findApplicantId(id: string, ex: Executor = this.db): Promise<string | null> {
    const row = await ex
      .selectFrom('users.instructorApplications')
      .select('applicantId')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.applicantId ?? null;
  }

  async hasPending(applicantId: string, ex: Executor = this.db): Promise<boolean> {
    const row = await ex
      .selectFrom('users.instructorApplications')
      .select('id')
      .where('applicantId', '=', applicantId)
      .where('status', '=', 'PENDING')
      .executeTakeFirst();
    return row !== undefined;
  }

  async listByApplicant(
    applicantId: string,
    ex: Executor = this.db,
  ): Promise<InstructorApplicationState[]> {
    // instructor_applications_applicant_id_submitted_at_idx
    const rows = await ex
      .selectFrom('users.instructorApplications as a')
      .select(APPLICATION_COLUMNS)
      .where('a.applicantId', '=', applicantId)
      .orderBy('a.submittedAt', 'desc')
      .orderBy('a.id', 'desc')
      .execute();
    return this.withTransitions(rows, ex);
  }

  async listByStatus(
    filter: ApplicationQueueFilter,
    ex: Executor = this.db,
  ): Promise<ApplicationQueueRow[]> {
    // instructor_applications_status_submitted_at_id_idx
    let query = ex
      .selectFrom('users.instructorApplications as a')
      .select([...APPLICATION_COLUMNS, SUBMITTED_AT_TEXT.as('submittedAtText')])
      .where('a.status', '=', filter.status);
    if (filter.after !== undefined) {
      const after: ApplicationKeyset = filter.after;
      query = query.where(
        sql<boolean>`(a.submitted_at, a.id) > (${after.submittedAt}::timestamptz, ${after.id}::uuid)`,
      );
    }
    const rows = await query
      .orderBy('a.submittedAt', 'asc')
      .orderBy('a.id', 'asc')
      .limit(filter.take)
      .execute();
    const states = await this.withTransitions(rows, ex);
    return states.map((application, index) => ({
      application,
      keyset: { submittedAt: rows[index]?.submittedAtText ?? '', id: application.id },
    }));
  }

  insert(trx: Transaction<DB>, submission: ApplicationSubmission): Promise<{ id: string }> {
    return mapUsersConstraints(async () => {
      const row = await trx
        .insertInto('users.instructorApplications')
        .values({
          applicantId: submission.applicantId,
          status: submission.transition.toStatus,
          motivation: submission.motivation,
          expertise: submission.expertise,
          experienceLevel: submission.experienceLevel,
          portfolioUrl: submission.portfolioUrl,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      // Same transaction, same now(): occurred_at = submitted_at.
      await trx
        .insertInto('users.instructorApplicationTransitions')
        .values({
          applicationId: row.id,
          fromStatus: submission.transition.fromStatus,
          toStatus: submission.transition.toStatus,
          actorId: submission.transition.actorId,
          reason: submission.transition.reason,
        })
        .execute();
      return { id: row.id };
    });
  }

  async applyDecision(
    trx: Transaction<DB>,
    decision: ApplicationDecision,
    expectedVersion: number | undefined,
  ): Promise<ApplyDecisionResult> {
    let query = trx
      .updateTable('users.instructorApplications')
      .set((eb) => ({ status: decision.toStatus, version: eb('version', '+', 1) }))
      .where('id', '=', decision.applicationId)
      .where('status', '=', decision.fromStatus);
    if (expectedVersion !== undefined) query = query.where('version', '=', expectedVersion);
    const row = await mapUsersConstraints(() => query.returning('version').executeTakeFirst());
    return row === undefined ? { applied: false } : { applied: true, version: row.version };
  }

  insertTransition(
    trx: Transaction<DB>,
    decision: ApplicationDecision,
  ): Promise<{ occurredAt: Date }> {
    return mapUsersConstraints(() =>
      trx
        .insertInto('users.instructorApplicationTransitions')
        .values({
          applicationId: decision.applicationId,
          fromStatus: decision.fromStatus,
          toStatus: decision.toStatus,
          actorId: decision.actorId,
          reason: decision.reason,
        })
        .returning('occurredAt')
        .executeTakeFirstOrThrow(),
    );
  }

  /** One query for the transitions of all `rows` (no N+1), oldest first per application. */
  private async withTransitions(
    rows: readonly ApplicationRow[],
    ex: Executor,
  ): Promise<InstructorApplicationState[]> {
    if (rows.length === 0) return [];
    // ia_transitions_application_id_to_status_uq leads with application_id.
    const transitions = await ex
      .selectFrom('users.instructorApplicationTransitions')
      .select(['applicationId', 'fromStatus', 'toStatus', 'actorId', 'reason', 'occurredAt'])
      .where('applicationId', '=', sql<string>`any(${sql.val(rows.map((r) => r.id))}::uuid[])`)
      .orderBy('occurredAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
    const byApplication = new Map<string, ApplicationTransition[]>();
    for (const row of transitions) {
      const list = byApplication.get(row.applicationId) ?? [];
      list.push(toTransition(row));
      byApplication.set(row.applicationId, list);
    }
    return rows.map((row) => toState(row, byApplication.get(row.id) ?? []));
  }
}
