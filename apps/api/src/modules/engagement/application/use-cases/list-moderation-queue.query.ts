import { Injectable } from '@nestjs/common';
import type {
  ModerationQueueItem,
  ModerationQueuePage,
  ReportStatus,
  ReportSubjectType,
} from '@udemy/contracts';
import { subjectKey } from '../../domain/moderation';
import { decodeOptionalKeyset, toPage } from '../engagement-cursor';
import { ModerationReader } from '../moderation-reader';
import { toModerationQueueItem } from '../moderation-views';
import { ModerationRepository } from '../ports/moderation.repository';

export interface ListModerationQueueInput {
  readonly type?: ReportSubjectType | undefined;
  readonly status: ReportStatus;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * `AdminListReports` (design §5, D13; `GET /admin/moderation/reports`): one item per reported
 * subject with at least one report in `status` (default OPEN), the most recently reported
 * first, keyset (lastReportedAt DESC, subject row id DESC). Each item has the subject preview,
 * its state, open-report count, audit log (oldest first) and newest 20 reports. Review replies
 * appear under their REVIEW id (the id the action routes take); the view stores reply ids.
 *
 * Errors: 400 (query), 422 invalid cursor.
 */
@Injectable()
export class ListModerationQueueQuery {
  constructor(
    private readonly moderation: ModerationRepository,
    private readonly reader: ModerationReader,
  ) {}

  async execute(input: ListModerationQueueInput): Promise<ModerationQueuePage> {
    const after = decodeOptionalKeyset(input.cursor);
    const rows = await this.moderation.queuePage({
      type: input.type,
      status: input.status,
      after: after === null ? null : { lastReportedAt: after.at, subjectId: after.id },
      limit: input.limit + 1,
    });
    const refs = rows.slice(0, input.limit).map((r) => r.ref);
    const details = await this.reader.details(refs, { withReports: true });
    return toPage(
      rows,
      input.limit,
      (row) => ({ at: row.lastReportedAtKey, id: row.ref.id }),
      (shown) =>
        shown.flatMap((row): ModerationQueueItem[] => {
          const key = subjectKey(row.ref.type, row.ref.id);
          const subject = details.subjects.get(key);
          // reports reference their subject with a real FK: a missing row is impossible
          if (subject === undefined) return [];
          return [
            toModerationQueueItem(subject, {
              courseTitle: details.courseTitles.get(subject.courseId) ?? null,
              openReportCount: details.openCounts.get(key) ?? 0,
              actions: details.actions.get(key) ?? [],
              reports: details.reports.get(key) ?? [],
              lastReportedAt: row.lastReportedAt,
              people: details.people,
            }),
          ];
        }),
    );
  }
}
