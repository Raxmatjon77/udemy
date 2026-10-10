import { Injectable } from '@nestjs/common';
import type { AssetView, CourseReadiness } from '@udemy/contracts';
import type { Executor } from '@udemy/db';
import { isEffectivelyActive } from '../domain/category';
import { plainTextLength } from '../domain/markdown';
import { evaluateReadiness, type ReadinessAsset } from '../domain/readiness';
import { CatalogSettings } from './catalog-settings';
import { CurriculumReader, type LoadedCurriculum } from './curriculum-reader';
import { CategoryRepository } from './ports/category.repository';
import type { CourseRecord } from './ports/course.repository';
import { CourseRepository } from './ports/course.repository';

function toReadinessAsset(asset: AssetView | null | undefined): ReadinessAsset | null {
  if (asset === null || asset === undefined) return null;
  return { status: asset.status, purged: asset.purged, durationSeconds: asset.durationSeconds };
}

/**
 * Gathers the facts of invariant 6 and runs the pure `evaluateReadiness` (design §4). Used by
 * CourseDetail (the builder's checklist) and, in P2-T10, by SubmitCourse inside its
 * transaction: pass the `trx` so asset states and durations are read fresh in it.
 */
@Injectable()
export class CourseReadinessEvaluator {
  constructor(
    private readonly courses: CourseRepository,
    private readonly categories: CategoryRepository,
    private readonly reader: CurriculumReader,
    private readonly settings: CatalogSettings,
  ) {}

  async evaluate(
    course: CourseRecord,
    ex?: Executor,
    preloaded?: { readonly curriculum: LoadedCurriculum; readonly outcomeCount: number },
  ): Promise<CourseReadiness> {
    const curriculum = preloaded?.curriculum ?? (await this.reader.load(course, ex));
    const outcomeCount =
      preloaded?.outcomeCount ?? (await this.courses.getBullets(course.id, ex)).outcomes.length;
    const category =
      course.categoryId === null ? null : await this.categories.findById(course.categoryId, ex);

    return evaluateReadiness(
      {
        subtitle: course.subtitle,
        descriptionPlainLength:
          course.descriptionMd === null ? null : plainTextLength(course.descriptionMd),
        language: course.language,
        level: course.level,
        categoryId: course.categoryId,
        categoryActive: category === null ? null : isEffectivelyActive(category),
        thumbnailAssetId: course.thumbnailAssetId,
        thumbnail:
          course.thumbnailAssetId === null
            ? null
            : toReadinessAsset(curriculum.assets.get(course.thumbnailAssetId)),
        outcomeCount,
        sections: curriculum.sections.map((s) => ({
          id: s.record.id,
          lectures: s.lectures.map((l) => ({
            id: l.record.id,
            type: l.record.type,
            mediaAssetId: l.record.mediaAssetId,
            asset: toReadinessAsset(l.asset),
            articlePlainLength: l.articlePlainLength,
          })),
        })),
      },
      this.settings.readiness,
    );
  }
}
