import type { Metadata } from 'next';
import { ReportStatusSchema, ReportSubjectTypeSchema } from '@udemy/contracts';

import { ModerationQueue } from './moderation-queue';

export const metadata: Metadata = { title: 'Moderation' };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ModerationPage({ searchParams }: PageProps<'/moderation'>) {
  const params = await searchParams;
  const type = ReportSubjectTypeSchema.safeParse(first(params.type));
  const status = ReportStatusSchema.safeParse(first(params.status));
  const typeValue = type.success ? type.data : null;
  const statusValue = status.success ? status.data : 'OPEN';

  return (
    <>
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Moderation</h1>
        <p className="text-sm text-muted-foreground">
          Reported reviews, review replies, questions and answers, newest report first. Content with
          3 or more open reports is hidden automatically until you confirm or restore it.
        </p>
      </div>
      <ModerationQueue key={`${typeValue}:${statusValue}`} type={typeValue} status={statusValue} />
    </>
  );
}
