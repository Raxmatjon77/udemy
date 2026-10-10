import { Injectable } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import {
  type ApplicationDecision,
  InstructorApplication,
  type InstructorApplicationState,
} from '../domain/instructor-application';
import {
  InstructorApplicationNotFound,
  InvalidStateTransition,
  VersionConflict,
} from '../domain/users.errors';
import { InstructorApplicationRepository } from './ports/instructor-application.repository';

export interface DecidedTransition {
  readonly decision: ApplicationDecision;
  /** SQL `now()` of the transition row (= the decision time in events). */
  readonly occurredAt: Date;
}

/**
 * The shared write path of approve, reject and withdraw, inside the caller's transaction:
 *
 * 1. load the application and let the aggregate decide (state machine, actor rules);
 * 2. conditional `UPDATE ... WHERE status = 'PENDING' [AND version = ?]`. It takes the row
 *    lock, so of two concurrent decisions the second waits, re-evaluates the WHERE after the
 *    first commits and matches nothing: exactly one wins;
 * 3. append the transition row (the DB re-checks edge, uniqueness and actor rules).
 *
 * A miss in step 2 is explained from fresh state: gone (404), stale `expectedVersion` (409
 * `version_conflict`) or no longer PENDING (409 `invalid_state_transition`).
 */
@Injectable()
export class InstructorApplicationDecider {
  constructor(private readonly applications: InstructorApplicationRepository) {}

  async decide(
    trx: Transaction<DB>,
    applicationId: string,
    expectedVersion: number | undefined,
    decide: (application: InstructorApplication) => ApplicationDecision,
  ): Promise<DecidedTransition> {
    const current = await this.load(trx, applicationId);
    assertVersion(current, expectedVersion);
    const decision = decide(InstructorApplication.rehydrate(current));

    const result = await this.applications.applyDecision(trx, decision, expectedVersion);
    if (!result.applied) {
      const latest = await this.load(trx, applicationId);
      assertVersion(latest, expectedVersion);
      throw new InvalidStateTransition({ from: latest.status, to: decision.toStatus });
    }
    const { occurredAt } = await this.applications.insertTransition(trx, decision);
    return { decision, occurredAt };
  }

  /** @throws InstructorApplicationNotFound */
  async load(trx: Transaction<DB>, applicationId: string): Promise<InstructorApplicationState> {
    const application = await this.applications.findById(applicationId, trx);
    if (application === null) throw new InstructorApplicationNotFound();
    return application;
  }
}

function assertVersion(
  application: InstructorApplicationState,
  expectedVersion: number | undefined,
): void {
  if (expectedVersion !== undefined && application.version !== expectedVersion) {
    throw new VersionConflict();
  }
}
