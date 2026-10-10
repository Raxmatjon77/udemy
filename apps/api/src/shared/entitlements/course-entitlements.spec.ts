import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  COURSE_ENTITLEMENTS,
  type CourseEntitlements,
  CourseEntitlementsModule,
  DenyAllCourseEntitlements,
} from './index';

/** Stands in for a bounded context (e.g. catalog) that injects the port without importing it. */
@Injectable()
class Consumer {
  constructor(@Inject(COURSE_ENTITLEMENTS) readonly entitlements: CourseEntitlements) {}
}

@Module({ providers: [Consumer], exports: [Consumer] })
class ConsumerModule {}

class AllowAll implements CourseEntitlements {
  hasCourseAccess(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

@Module({ providers: [AllowAll], exports: [AllowAll] })
class FakeEnrollmentModule {}

describe('CourseEntitlements', () => {
  it('the Phase 2 default denies every user/course pair', async () => {
    const entitlements: CourseEntitlements = new DenyAllCourseEntitlements();
    await expect(entitlements.hasCourseAccess('user-1', 'course-1')).resolves.toBe(false);
    await expect(entitlements.hasCourseAccess('', '')).resolves.toBe(false);
  });

  it('forRoot binds the token globally, so other modules inject it without importing', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CourseEntitlementsModule.forRoot({ useClass: DenyAllCourseEntitlements }),
        ConsumerModule,
      ],
    }).compile();

    const consumer = moduleRef.get(Consumer);
    expect(consumer.entitlements).toBeInstanceOf(DenyAllCourseEntitlements);
    await expect(consumer.entitlements.hasCourseAccess('u', 'c')).resolves.toBe(false);
    await moduleRef.close();
  });

  it('can be rebound to a provider exported by another module (the Phase 4 shape)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CourseEntitlementsModule.forRoot({
          imports: [FakeEnrollmentModule],
          useExisting: AllowAll,
        }),
        ConsumerModule,
      ],
    }).compile();

    const consumer = moduleRef.get(Consumer);
    expect(consumer.entitlements).toBe(moduleRef.get(AllowAll));
    await expect(consumer.entitlements.hasCourseAccess('u', 'c')).resolves.toBe(true);
    await moduleRef.close();
  });
});
