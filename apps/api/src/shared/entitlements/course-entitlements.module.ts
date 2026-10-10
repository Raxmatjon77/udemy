import {
  type ClassProvider,
  type DynamicModule,
  type ExistingProvider,
  type FactoryProvider,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { COURSE_ENTITLEMENTS, type CourseEntitlements } from './course-entitlements';

/** How AppModule binds `COURSE_ENTITLEMENTS`: any Nest provider shape minus the token. */
export type CourseEntitlementsBinding = (
  | Omit<ClassProvider<CourseEntitlements>, 'provide'>
  | Omit<ExistingProvider<CourseEntitlements>, 'provide'>
  | Omit<FactoryProvider<CourseEntitlements>, 'provide'>
) & {
  /** Modules that export what the binding needs (Phase 4: the enrollment module facade). */
  readonly imports?: ModuleMetadata['imports'];
};

/**
 * Makes `COURSE_ENTITLEMENTS` injectable everywhere (global). Imports no bounded context
 * itself: the binding, and the module that provides it, are chosen once in AppModule.
 *
 *   // Phase 2
 *   CourseEntitlementsModule.forRoot({ useClass: DenyAllCourseEntitlements })
 *   // Phase 4
 *   CourseEntitlementsModule.forRoot({ imports: [EnrollmentModule], useExisting: EnrollmentEntitlements })
 */
@Module({})
export class CourseEntitlementsModule {
  static forRoot(binding: CourseEntitlementsBinding): DynamicModule {
    const { imports, ...provider } = binding;
    return {
      module: CourseEntitlementsModule,
      global: true,
      imports: imports ?? [],
      providers: [{ ...provider, provide: COURSE_ENTITLEMENTS }],
      exports: [COURSE_ENTITLEMENTS],
    };
  }
}
