import { Injectable } from '@nestjs/common';
import type { BrowseCoursesQuery as BrowseCoursesRequest, CourseCardPage } from '@udemy/contracts';
import { MediaFacade } from '../../../media';
import { UsersFacade } from '../../../users';
import { decodeBrowseCursor, encodeBrowseCursor } from '../course-cursor';
import { PublicCatalogRepository } from '../ports/public-catalog.repository';
import {
  browseCategoryIds,
  CategoryDirectory,
  isServableThumbnail,
} from '../public-catalog-support';

/**
 * `BrowseCourses` (design §5, public): course cards of PUBLISHED courses, built from their LIVE
 * revision only, newest first; keyset `(first_published_at DESC, id DESC)` with the exact
 * microsecond text in the cursor (design §14). Filters: category slug (a group includes its
 * active leaves; an unknown or deactivated slug is an empty page), level, language and a
 * title substring (`q`, LIKE-escaped).
 *
 * Instructor names come from `UsersFacade.getPublicProfiles`, which hides banned users (their
 * card shows no instructor). One query each for the page, the totals, the profiles and the
 * thumbnails (no N+1).
 */
@Injectable()
export class BrowseCoursesQuery {
  constructor(
    private readonly publicCatalog: PublicCatalogRepository,
    private readonly users: UsersFacade,
    private readonly media: MediaFacade,
  ) {}

  async execute(request: BrowseCoursesRequest): Promise<CourseCardPage> {
    const after = request.cursor === undefined ? undefined : decodeBrowseCursor(request.cursor);
    const allCategories = await this.publicCatalog.listCategories();
    const categories = new CategoryDirectory(allCategories);
    let categoryIds: readonly string[] | undefined;
    if (request.category !== undefined) {
      categoryIds = browseCategoryIds(allCategories, request.category);
      if (categoryIds.length === 0) return { items: [], nextCursor: null };
    }

    const rows = await this.publicCatalog.browse({
      limit: request.limit + 1,
      after,
      categoryIds,
      level: request.level,
      language: request.language,
      titleContains: request.q,
    });
    const page = rows.slice(0, request.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > request.limit && last !== undefined ? encodeBrowseCursor(last.cursor) : null;
    if (page.length === 0) return { items: [], nextCursor: null };

    const [totals, profiles, thumbnails] = await Promise.all([
      this.publicCatalog.liveTotals(page.map((r) => r.id)),
      this.users.getPublicProfiles([...new Set(page.map((r) => r.ownerId))]),
      this.media.getAssets(page.map((r) => r.thumbnailAssetId)),
    ]);
    const instructors = new Map(profiles.map((p) => [p.id, p]));
    const servable = new Set(thumbnails.filter(isServableThumbnail).map((a) => a.id));

    return {
      items: page.map((row) => {
        const instructor = instructors.get(row.ownerId);
        const total = totals.get(row.id);
        return {
          id: row.id,
          slug: row.slug,
          title: row.title,
          subtitle: row.subtitle,
          level: row.level,
          language: row.language,
          category: categories.leaf(row.categoryId),
          instructor:
            instructor === undefined
              ? null
              : { id: instructor.id, displayName: instructor.displayName },
          lectureCount: total?.lectureCount ?? 0,
          videoSeconds: total?.videoSeconds ?? 0,
          hasThumbnail: servable.has(row.thumbnailAssetId),
          publishedAt: row.firstPublishedAt.toISOString(),
        };
      }),
      nextCursor,
    };
  }
}
