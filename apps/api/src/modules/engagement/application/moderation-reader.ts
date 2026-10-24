import { Injectable } from '@nestjs/common';
import type { PersonRef } from '@udemy/contracts';
import { CatalogFacade } from '../../catalog';
import {
  type ModerationActionRecord,
  type ModerationReportRecord,
  type ModerationSubjectRecord,
  subjectKey,
} from '../domain/moderation';
import { moderationPeopleIds } from './moderation-views';
import { PeopleDirectory } from './people';
import { ModerationRepository, type SubjectRef } from './ports/moderation.repository';

/** Everything the admin views show about a set of subjects, loaded in a fixed number of queries. */
export interface ModerationDetails {
  readonly subjects: ReadonlyMap<string, ModerationSubjectRecord>;
  readonly openCounts: ReadonlyMap<string, number>;
  readonly actions: ReadonlyMap<string, readonly ModerationActionRecord[]>;
  readonly reports: ReadonlyMap<string, readonly ModerationReportRecord[]>;
  readonly courseTitles: ReadonlyMap<string, string>;
  readonly people: ReadonlyMap<string, PersonRef>;
}

function groupBySubject<T extends { subjectType: SubjectRef['type']; subjectId: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = subjectKey(row.subjectType, row.subjectId);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

/**
 * Loads subjects with their open-report counts, audit log, newest reports (optional), course
 * titles (live title; null once the course is gone) and names. Names are PUBLIC profiles: a
 * banned author, reporter or actor shows as null (there is no admin-only directory facade).
 */
@Injectable()
export class ModerationReader {
  constructor(
    private readonly moderation: ModerationRepository,
    private readonly catalog: CatalogFacade,
    private readonly people: PeopleDirectory,
  ) {}

  async details(
    refs: readonly SubjectRef[],
    options: { readonly withReports: boolean },
  ): Promise<ModerationDetails> {
    const [subjects, openCounts, actions, reports] = await Promise.all([
      this.moderation.loadSubjects(refs),
      this.moderation.openReportCounts(refs),
      this.moderation.actionsOf(refs),
      options.withReports ? this.moderation.reportsOf(refs, 20) : Promise.resolve([]),
    ]);
    const courseIds = [...new Set([...subjects.values()].map((s) => s.courseId))];
    const [courses, people] = await Promise.all([
      this.catalog.getCourseSummaries(courseIds),
      this.people.lookup(moderationPeopleIds([...subjects.values()], reports, actions)),
    ]);
    return {
      subjects,
      openCounts,
      actions: groupBySubject(actions),
      reports: groupBySubject(reports),
      courseTitles: new Map(courses.map((c) => [c.id, c.title])),
      people,
    };
  }
}
