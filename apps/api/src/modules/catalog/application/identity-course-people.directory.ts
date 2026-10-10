import { Injectable } from '@nestjs/common';
import { IdentityFacade } from '../../identity';
import { CoursePeopleDirectory, type CoursePerson } from './ports/course-people.directory';

/**
 * Display names and ban state from identity (`IdentityFacade.getUserSummaries`, design §8
 * "owner ban flag via IdentityFacade"). Banned users are included on purpose (moderation
 * views); the public instructor card keeps using `UsersFacade`, which hides them. Lives in
 * application/ because only application code may reach another module's facade.
 */
@Injectable()
export class IdentityCoursePeopleDirectory extends CoursePeopleDirectory {
  constructor(private readonly identity: IdentityFacade) {
    super();
  }

  async findPeople(userIds: readonly string[]): Promise<ReadonlyMap<string, CoursePerson>> {
    const summaries = await this.identity.getUserSummaries(userIds);
    return new Map(
      summaries.map((s) => [s.id, { displayName: s.displayName, banned: s.status === 'BANNED' }]),
    );
  }
}
