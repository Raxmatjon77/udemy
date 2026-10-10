// Public facade of the catalog context: the only file other modules may import.
export { CatalogModule } from './catalog.module';
export {
  CatalogFacade,
  COURSE_SUMMARIES_MAX_IDS,
  type CourseSummary,
  type PublishedCourseSummary,
} from './application/catalog.facade';
