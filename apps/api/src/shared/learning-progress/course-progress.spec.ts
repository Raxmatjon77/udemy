import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  COURSE_PROGRESS,
  type CourseProgressReader,
  CourseProgressModule,
  NoCourseProgress,
} from './index';

/** Stands in for enrollment, which injects the port without importing learning. */
@Injectable()
class Consumer {
  constructor(@Inject(COURSE_PROGRESS) readonly progress: CourseProgressReader) {}
}

@Module({ providers: [Consumer], exports: [Consumer] })
class ConsumerModule {}

class HalfDone implements CourseProgressReader {
  getPercents(_userId: string, courseIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return Promise.resolve(new Map(courseIds.map((id) => [id, 50])));
  }
}

@Module({ providers: [HalfDone], exports: [HalfDone] })
class FakeLearningModule {}

describe('CourseProgress', () => {
  it('the default reader knows no progress (my-learning keeps progress: null)', async () => {
    const reader: CourseProgressReader = new NoCourseProgress();
    const percents = await reader.getPercents('user-1', ['course-1', 'course-2']);
    expect(percents.size).toBe(0);
    expect(percents.get('course-1')).toBeUndefined();
  });

  it('forRoot binds the token globally, so other modules inject it without importing', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CourseProgressModule.forRoot({ useClass: NoCourseProgress }), ConsumerModule],
    }).compile();

    const consumer = moduleRef.get(Consumer);
    expect(consumer.progress).toBeInstanceOf(NoCourseProgress);
    await moduleRef.close();
  });

  it('can be rebound to a provider exported by another module (the P5-T10 shape)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CourseProgressModule.forRoot({ imports: [FakeLearningModule], useExisting: HalfDone }),
        ConsumerModule,
      ],
    }).compile();

    const consumer = moduleRef.get(Consumer);
    expect(consumer.progress).toBe(moduleRef.get(HalfDone));
    await expect(consumer.progress.getPercents('u', ['c'])).resolves.toEqual(new Map([['c', 50]]));
    await moduleRef.close();
  });
});
