import { COURSE_SUBMISSION_DEFAULTS } from '@udemy/contracts';
import type { ReadinessThresholds } from '../domain/readiness';

/** Catalog configuration from the validated env (`CATALOG_*`, design §13). */
export class CatalogSettings {
  constructor(readonly readiness: ReadinessThresholds) {}

  static defaults(): CatalogSettings {
    return new CatalogSettings({
      minLectures: COURSE_SUBMISSION_DEFAULTS.minLectures,
      minVideoSeconds: COURSE_SUBMISSION_DEFAULTS.minVideoSeconds,
    });
  }
}
