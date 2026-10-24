import { Injectable } from '@nestjs/common';
import type { WishlistItem, WishlistPage } from '@udemy/contracts';
import { CatalogFacade } from '../../../catalog';
import { decodeOptionalKeyset, toPage } from '../engagement-cursor';
import { PeopleDirectory, personOf } from '../people';
import { type WishlistRow, WishlistRepository } from '../ports/wishlist.repository';

/**
 * `ListWishlist` (design §5): newest first, keyset (addedAt DESC, courseId DESC), with the LIVE
 * course card. An archived course stays listed (`available: false`) so the user can remove it;
 * a course without a live revision any more (deleted) is skipped.
 */
@Injectable()
export class ListWishlistQuery {
  constructor(
    private readonly wishlist: WishlistRepository,
    private readonly catalog: CatalogFacade,
    private readonly people: PeopleDirectory,
  ) {}

  async execute(input: {
    userId: string;
    cursor?: string | undefined;
    limit: number;
  }): Promise<WishlistPage> {
    const after = decodeOptionalKeyset(input.cursor);
    const rows = await this.wishlist.listPage(
      input.userId,
      after === null ? null : { addedAt: after.at, courseId: after.id },
      input.limit + 1,
    );
    const page = rows.slice(0, input.limit);
    const courses = await this.catalog.getCourseSummaries(page.map((r) => r.courseId));
    const byId = new Map(courses.map((c) => [c.id, c]));
    const people = await this.people.lookup(courses.map((c) => c.ownerId));
    return toPage(
      rows,
      input.limit,
      (row) => ({ at: row.addedAtKey, id: row.courseId }),
      (pageRows: readonly WishlistRow[]) =>
        pageRows.flatMap((row): WishlistItem[] => {
          const course = byId.get(row.courseId);
          if (course === undefined) return [];
          return [
            {
              courseId: course.id,
              slug: course.slug,
              title: course.title,
              instructor: personOf(people, course.ownerId),
              hasThumbnail: course.hasThumbnail,
              available: course.status === 'PUBLISHED',
              addedAt: row.addedAt.toISOString(),
            },
          ];
        }),
    );
  }
}
