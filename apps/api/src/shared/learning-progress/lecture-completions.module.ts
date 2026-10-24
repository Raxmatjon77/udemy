import {
  type ClassProvider,
  type DynamicModule,
  type ExistingProvider,
  type FactoryProvider,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { LECTURE_COMPLETIONS, type LectureCompletionCounter } from './lecture-completions';

/** How AppModule binds `LECTURE_COMPLETIONS`: any Nest provider shape minus the token. */
export type LectureCompletionsBinding = (
  | Omit<ClassProvider<LectureCompletionCounter>, 'provide'>
  | Omit<ExistingProvider<LectureCompletionCounter>, 'provide'>
  | Omit<FactoryProvider<LectureCompletionCounter>, 'provide'>
) & {
  /** Modules that export what the binding needs (P5-T10: the learning module facade). */
  readonly imports?: ModuleMetadata['imports'];
};

/**
 * Makes `LECTURE_COMPLETIONS` injectable everywhere (global). Imports no bounded context
 * itself: the binding, and the module that provides it, are chosen once in AppModule (the
 * `CourseProgressModule` / `CourseEntitlementsModule` pattern).
 *
 *   // until P5-T10 (fail closed: nobody is eligible to review)
 *   LectureCompletionsModule.forRoot({ useClass: NoLectureCompletions })
 *   // P5-T10
 *   LectureCompletionsModule.forRoot({ imports: [LearningModule], useExisting: LearningFacade })
 */
@Module({})
export class LectureCompletionsModule {
  static forRoot(binding: LectureCompletionsBinding): DynamicModule {
    const { imports, ...provider } = binding;
    return {
      module: LectureCompletionsModule,
      global: true,
      imports: imports ?? [],
      providers: [{ ...provider, provide: LECTURE_COMPLETIONS }],
      exports: [LECTURE_COMPLETIONS],
    };
  }
}
