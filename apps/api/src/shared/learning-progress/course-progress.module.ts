import {
  type ClassProvider,
  type DynamicModule,
  type ExistingProvider,
  type FactoryProvider,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { COURSE_PROGRESS, type CourseProgressReader } from './course-progress';

/** How AppModule binds `COURSE_PROGRESS`: any Nest provider shape minus the token. */
export type CourseProgressBinding = (
  | Omit<ClassProvider<CourseProgressReader>, 'provide'>
  | Omit<ExistingProvider<CourseProgressReader>, 'provide'>
  | Omit<FactoryProvider<CourseProgressReader>, 'provide'>
) & {
  /** Modules that export what the binding needs (P5-T10: the learning module facade). */
  readonly imports?: ModuleMetadata['imports'];
};

/**
 * Makes `COURSE_PROGRESS` injectable everywhere (global). Imports no bounded context itself:
 * the binding, and the module that provides it, are chosen once in AppModule (the
 * `CourseEntitlementsModule` pattern).
 *
 *   // until P5-T10
 *   CourseProgressModule.forRoot({ useClass: NoCourseProgress })
 *   // P5-T10
 *   CourseProgressModule.forRoot({ imports: [LearningModule], useExisting: LearningProgressReader })
 */
@Module({})
export class CourseProgressModule {
  static forRoot(binding: CourseProgressBinding): DynamicModule {
    const { imports, ...provider } = binding;
    return {
      module: CourseProgressModule,
      global: true,
      imports: imports ?? [],
      providers: [{ ...provider, provide: COURSE_PROGRESS }],
      exports: [COURSE_PROGRESS],
    };
  }
}
