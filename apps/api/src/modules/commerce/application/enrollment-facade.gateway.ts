import { Injectable } from '@nestjs/common';
import type { DB, Executor, Transaction } from '@udemy/db';
import { EnrollmentFacade } from '../../enrollment';
import {
  CommerceEnrollments,
  type CommerceGrantInput,
  type CommerceGrantResult,
  type CommerceRevokeInput,
  type CommerceRevokeResult,
} from './ports/context-gateways';

/**
 * `CommerceEnrollments` over `EnrollmentFacade` (design §3). Grants and revokes run on the
 * caller's transaction, so "PAID <=> enrolled" stays atomic (D8); several grants in one
 * transaction must be made in ascending course id (schema doc R8).
 */
@Injectable()
export class EnrollmentFacadeGateway extends CommerceEnrollments {
  constructor(private readonly enrollments: EnrollmentFacade) {
    super();
  }

  activeCourseIds(
    userId: string,
    courseIds: readonly string[],
    ex?: Executor,
  ): Promise<ReadonlySet<string>> {
    if (courseIds.length === 0) return Promise.resolve(new Set());
    return this.enrollments.activeCourseIds(userId, courseIds, ex);
  }

  grant(trx: Transaction<DB>, input: CommerceGrantInput): Promise<CommerceGrantResult> {
    return this.enrollments.grant(trx, input);
  }

  revoke(trx: Transaction<DB>, input: CommerceRevokeInput): Promise<CommerceRevokeResult> {
    return this.enrollments.revoke(trx, input);
  }
}
