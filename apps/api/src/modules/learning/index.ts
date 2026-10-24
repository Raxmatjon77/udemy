// Public facade of the learning context: the only file other modules may import.
export { LearningModule } from './learning.module';
export { LearningFacade, type LearningConsumption } from './application/learning.facade';
// For AppModule only: CourseProgressModule.forRoot({ imports: [LearningModule], useExisting: LearningProgressReader }).
export { LearningProgressReader } from './application/learning-progress.reader';
