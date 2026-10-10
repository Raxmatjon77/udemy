import { Injectable } from '@nestjs/common';
import type { Executor } from '@udemy/db';
import { CatalogFacade } from '../../catalog';
import { IdentityFacade } from '../../identity';
import type { QuoteCourse } from '../domain/quote';
import { CommerceCatalog, CommercePeople, type CommercePerson } from './ports/context-gateways';

/** `CommerceCatalog` over `CatalogFacade.getCourseSummaries` (the live revision's title). */
@Injectable()
export class CatalogFacadeGateway extends CommerceCatalog {
  constructor(private readonly catalog: CatalogFacade) {
    super();
  }

  async getCourses(courseIds: readonly string[], ex?: Executor): Promise<QuoteCourse[]> {
    if (courseIds.length === 0) return [];
    const summaries = await this.catalog.getCourseSummaries(courseIds, ex);
    return summaries.map((s) => ({
      id: s.id,
      slug: s.slug,
      ownerId: s.ownerId,
      status: s.status,
      title: s.title,
      hasThumbnail: s.hasThumbnail,
    }));
  }
}

/** `CommercePeople` over `IdentityFacade.getUserSummaries` (banned users are flagged). */
@Injectable()
export class IdentityFacadePeople extends CommercePeople {
  constructor(private readonly identity: IdentityFacade) {
    super();
  }

  async findPeople(
    userIds: readonly string[],
    ex?: Executor,
  ): Promise<ReadonlyMap<string, CommercePerson>> {
    const summaries = await this.identity.getUserSummaries(userIds, ex);
    return new Map(
      summaries.map((s) => [s.id, { displayName: s.displayName, banned: s.status === 'BANNED' }]),
    );
  }
}
