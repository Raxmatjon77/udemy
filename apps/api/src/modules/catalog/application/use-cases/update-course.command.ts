import { Injectable } from '@nestjs/common';
import type { CourseDetail, UpdateCourseRequest } from '@udemy/contracts';
import { assertAssignable } from '../../domain/category';
import { assertExpectedVersion, assertSlugEditable } from '../../domain/course';
import { assertMarkdownAllowed } from '../../domain/markdown';
import { CourseDetailAssembler } from '../course-detail.assembler';
import { CourseLocker } from '../course-locker';
import { CategoryRepository } from '../ports/category.repository';
import { type CourseHeaderPatch, CourseRepository } from '../ports/course.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface UpdateCourseInput {
  readonly actorId: string;
  readonly courseId: string;
  readonly changes: Omit<UpdateCourseRequest, 'expectedVersion'>;
  readonly expectedVersion?: number;
}

/**
 * `UpdateCourseDetails` (design §5): header fields, slug and the outcome/requirement lists in
 * one transaction under the course lock.
 *
 * - `expectedVersion` stale: 409 `version_conflict`;
 * - pending revision: 409 `course_in_review`; archived: 409 `course_not_editable`;
 * - slug after the first publication: 409 `slug_frozen`; taken: 409 `slug_taken`;
 * - description markdown with HTML/images/unsafe links: 422 `markdown_not_allowed`;
 * - a new category must be an active leaf (FOR SHARE, after the course lock).
 */
@Injectable()
export class UpdateCourseCommand {
  constructor(
    private readonly courses: CourseRepository,
    private readonly categories: CategoryRepository,
    private readonly locker: CourseLocker,
    private readonly detail: CourseDetailAssembler,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: UpdateCourseInput): Promise<CourseDetail> {
    const { changes } = input;
    // Pure checks first: no lock is taken for a request that cannot succeed.
    if (changes.descriptionMd !== undefined && changes.descriptionMd !== null) {
      assertMarkdownAllowed('descriptionMd', changes.descriptionMd);
    }

    return this.tx.run(async (trx) => {
      const course = await this.locker.lockEditable(trx, input.courseId, input.actorId);
      assertExpectedVersion(course, input.expectedVersion);

      const patch: { -readonly [K in keyof CourseHeaderPatch]: CourseHeaderPatch[K] } = {};
      if (changes.title !== undefined) patch.title = changes.title;
      if (changes.subtitle !== undefined) patch.subtitle = changes.subtitle;
      if (changes.descriptionMd !== undefined) patch.descriptionMd = changes.descriptionMd;
      if (changes.language !== undefined) patch.language = changes.language;
      if (changes.level !== undefined) patch.level = changes.level;
      if (changes.slug !== undefined && changes.slug !== course.slug) {
        assertSlugEditable(course);
        patch.slug = changes.slug;
      }
      if (changes.categoryId !== undefined && changes.categoryId !== course.categoryId) {
        if (changes.categoryId !== null) {
          assertAssignable(await this.categories.findForShare(trx, changes.categoryId));
        }
        patch.categoryId = changes.categoryId;
      }
      if (changes.outcomes !== undefined) {
        await this.courses.replaceBullets(trx, course.id, 'OUTCOME', changes.outcomes);
      }
      if (changes.requirements !== undefined) {
        await this.courses.replaceBullets(trx, course.id, 'REQUIREMENT', changes.requirements);
      }

      const updated = await this.courses.updateHeader(trx, course.id, patch);
      return this.detail.build(updated, trx);
    });
  }
}
