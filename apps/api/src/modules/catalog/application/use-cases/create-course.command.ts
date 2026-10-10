import { Injectable } from '@nestjs/common';
import type { CourseDetail } from '@udemy/contracts';
import { assertAssignable } from '../../domain/category';
import { SlugTaken } from '../../domain/catalog.errors';
import { firstFreeSlug, slugBase, slugCandidatePrefix } from '../../domain/slug';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CatalogEventPublisher } from '../ports/catalog-event.publisher';
import { CategoryRepository } from '../ports/category.repository';
import { CourseLifecycleRepository } from '../ports/course-lifecycle.repository';
import { CourseRepository } from '../ports/course.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface CreateCourseInput {
  readonly ownerId: string;
  /** Already trimmed and length-checked by the request schema. */
  readonly title: string;
  readonly categoryId?: string;
}

/** A concurrent create can take the chosen slug between our read and our insert. */
const SLUG_ATTEMPTS = 5;

/**
 * `CreateCourse` (design §5): a DRAFT course with a slug generated from the title (D12:
 * ASCII-folded, `-2`, `-3`, ... on conflict), its CREATE transition (the root of the history
 * chain, which `courses_status_log_ck` verifies at COMMIT) and `CourseCreated`, in one
 * transaction. An optional category must be an active depth-2 category (read FOR SHARE).
 */
@Injectable()
export class CreateCourseCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly lifecycle: CourseLifecycleRepository,
    private readonly categories: CategoryRepository,
    private readonly events: CatalogEventPublisher,
    private readonly detail: CourseDetailAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: CreateCourseInput): Promise<CourseDetail> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.createOnce(input);
      } catch (error) {
        // Lost a slug race (courses_slug_active_uq): the next attempt sees the winner's slug.
        if (error instanceof SlugTaken && attempt < SLUG_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  private createOnce(input: CreateCourseInput): Promise<CourseDetail> {
    return this.tx.run(async (trx) => {
      if (input.categoryId !== undefined) {
        assertAssignable(await this.categories.findForShare(trx, input.categoryId));
      }
      const base = slugBase(input.title);
      const taken = await this.courses.findSlugsWithPrefix(trx, slugCandidatePrefix(base));
      const course = await this.courses.insert(trx, {
        ownerId: input.ownerId,
        slug: firstFreeSlug(base, taken),
        title: input.title,
        categoryId: input.categoryId ?? null,
      });
      await this.lifecycle.appendTransition(trx, {
        courseId: course.id,
        prevTransitionId: null,
        revisionId: null,
        action: 'CREATE',
        fromStatus: null,
        toStatus: 'DRAFT',
        actorId: input.ownerId,
        reason: null,
      });
      await this.events.courseCreated(trx, {
        courseId: course.id,
        ownerId: course.ownerId,
        title: course.title,
        createdAt: course.createdAt.toISOString(),
      });
      return this.detail.build(course, trx);
    });
  }
}
