import { Injectable } from '@nestjs/common';
import {
  type InstructorApplicationPage,
  type InstructorApplicationStatus,
  PAGE_LIMIT_MAX,
} from '@udemy/contracts';
import { ValidationError } from '@udemy/nest-common/errors';
import { IdentityFacade } from '../../../identity';
import { decodeApplicationCursor, encodeApplicationCursor } from '../application-cursor';
import { InstructorApplicationRepository } from '../ports/instructor-application.repository';
import { toApplicationDetail } from '../views';

export interface ListInstructorApplicationsInput {
  /** Default PENDING (the review queue). */
  readonly status?: InstructorApplicationStatus;
  readonly cursor?: string;
  /** 1..100. */
  readonly limit: number;
}

/**
 * `ListInstructorApplications` (admin, design §5): keyset page, oldest first. Every item is an
 * `InstructorApplicationDetail`; the applicant summaries of the whole page come from ONE
 * `IdentityFacade.getUserSummaries` call and the transitions from one query (no N+1).
 */
@Injectable()
export class ListInstructorApplicationsQuery {
  constructor(
    private readonly applications: InstructorApplicationRepository,
    private readonly identity: IdentityFacade,
  ) {}

  async execute(input: ListInstructorApplicationsInput): Promise<InstructorApplicationPage> {
    const { limit } = input;
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
      throw new ValidationError(`The limit must be between 1 and ${PAGE_LIMIT_MAX}.`, {
        issues: [{ path: 'limit', message: `Must be between 1 and ${PAGE_LIMIT_MAX}.` }],
      });
    }
    const after = input.cursor === undefined ? undefined : decodeApplicationCursor(input.cursor);
    const rows = await this.applications.listByStatus({
      status: input.status ?? 'PENDING',
      after,
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const applicants = await this.identity.getUserSummaries(
      page.map((row) => row.application.applicantId),
    );
    const applicantById = new Map(applicants.map((user) => [user.id, user]));
    const items = page.map(({ application }) => {
      const applicant = applicantById.get(application.applicantId);
      // FK to identity.users and no hard deletes: a missing applicant is a broken invariant.
      if (applicant === undefined) {
        throw new Error(`Applicant ${application.applicantId} of ${application.id} not found`);
      }
      return toApplicationDetail(application, applicant);
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last !== undefined ? encodeApplicationCursor(last.keyset) : null,
    };
  }
}
