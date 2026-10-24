import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  LECTURE_COMPLETIONS,
  type LectureCompletionCounter,
  LectureCompletionsModule,
  NoLectureCompletions,
} from './index';

/** Stands in for engagement, which injects the port without importing learning. */
@Injectable()
class Consumer {
  constructor(@Inject(LECTURE_COMPLETIONS) readonly completions: LectureCompletionCounter) {}
}

@Module({ providers: [Consumer], exports: [Consumer] })
class ConsumerModule {}

/** The P5-T10 shape: a facade with an extra optional executor parameter. */
@Injectable()
class FakeLearningFacade {
  completedLectureCount(_userId: string, _courseId: string, _ex?: unknown): Promise<number> {
    return Promise.resolve(3);
  }
}

@Module({ providers: [FakeLearningFacade], exports: [FakeLearningFacade] })
class FakeLearningModule {}

describe('LectureCompletions', () => {
  it('the default counter knows no completions (the review gate fails closed)', async () => {
    await expect(new NoLectureCompletions().completedLectureCount()).resolves.toBe(0);
  });

  it('forRoot binds the token globally, so other modules inject it without importing', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LectureCompletionsModule.forRoot({ useClass: NoLectureCompletions }),
        ConsumerModule,
      ],
    }).compile();

    expect(moduleRef.get(Consumer).completions).toBeInstanceOf(NoLectureCompletions);
    await moduleRef.close();
  });

  it('can be rebound to a facade exported by another module (the P5-T10 shape)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LectureCompletionsModule.forRoot({
          imports: [FakeLearningModule],
          useExisting: FakeLearningFacade,
        }),
        ConsumerModule,
      ],
    }).compile();

    const consumer = moduleRef.get(Consumer);
    expect(consumer.completions).toBe(moduleRef.get(FakeLearningFacade));
    await expect(consumer.completions.completedLectureCount('u', 'c')).resolves.toBe(3);
    await moduleRef.close();
  });
});
