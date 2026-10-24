import { Injectable } from '@nestjs/common';
import type { PersonRef } from '@udemy/contracts';
import { UsersFacade } from '../../users';

/**
 * Display names for authors (reviews, replies; Q&A in P5-T13): the PUBLIC profile only (design
 * §9 privacy). Banned and unknown users have none, so they are shown as null ("Former student").
 */
@Injectable()
export class PeopleDirectory {
  constructor(private readonly users: UsersFacade) {}

  async lookup(userIds: Iterable<string>): Promise<ReadonlyMap<string, PersonRef>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const profiles = await this.users.getPublicProfiles(ids);
    return new Map(profiles.map((p) => [p.id, { id: p.id, displayName: p.displayName }]));
  }
}

/** `people.get(id) ?? null` with a precise type. */
export function personOf(people: ReadonlyMap<string, PersonRef>, userId: string): PersonRef | null {
  return people.get(userId) ?? null;
}
