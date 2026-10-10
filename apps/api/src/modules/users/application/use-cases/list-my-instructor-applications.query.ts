import { Injectable } from '@nestjs/common';
import type { MyInstructorApplicationsResponse } from '@udemy/contracts';
import { InstructorApplicationRepository } from '../ports/instructor-application.repository';
import { toApplicationView } from '../views';

/** `ListMyInstructorApplications` (design §5): newest first, with transitions. */
@Injectable()
export class ListMyInstructorApplicationsQuery {
  constructor(private readonly applications: InstructorApplicationRepository) {}

  async execute(applicantId: string): Promise<MyInstructorApplicationsResponse> {
    const items = await this.applications.listByApplicant(applicantId);
    return { items: items.map(toApplicationView) };
  }
}
