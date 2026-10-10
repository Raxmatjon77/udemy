'use client';

import Link from 'next/link';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ErrorCode } from '@udemy/contracts';
import { Alert, AlertDescription, AlertTitle } from '@udemy/ui/components/alert';
import { Badge } from '@udemy/ui/components/badge';
import { Skeleton } from '@udemy/ui/components/skeleton';
import { cn } from '@udemy/ui/lib/utils';

import { CourseBadge } from '@/components/course-badge';
import { QueryError } from '@/components/query-error';
import { catalogApi } from '@/lib/catalog-api';
import { catalogKeys, setCourseData, useCourse, useCurriculum } from '@/lib/catalog-queries';
import type { BuilderTarget } from '@/lib/labels';
import { hasCode, problemMessage } from '@/lib/problem';

import { BUILDER_TABS, type BuilderTab } from './builder-tabs';
import { CurriculumTab } from './curriculum-tab';
import { DetailsTab } from './details-tab';
import { LectureDrawer } from './lecture-drawer';
import { LockBanner } from './lock-banner';
import { ReviewTab } from './review-tab';


const TAB_LABELS: Record<BuilderTab, string> = {
  details: 'Details',
  curriculum: 'Curriculum',
  review: 'Review',
};

/**
 * The course builder (design §10): Details, Curriculum and Review tabs over one course. While a
 * submission is pending (D2) or the course is archived, every tab is read-only.
 */
export function CourseBuilder({ courseId, initialTab = 'details' }: { courseId: string; initialTab?: BuilderTab }) {
  const queryClient = useQueryClient();
  const course = useCourse(courseId);
  const curriculum = useCurriculum(courseId);
  const [tab, setTab] = useState<BuilderTab>(initialTab);
  const [openLectureId, setOpenLectureId] = useState<string | null>(null);
  const tabRefs = useRef<Record<BuilderTab, HTMLButtonElement | null>>({
    details: null,
    curriculum: null,
    review: null,
  });

  const withdraw = useMutation({
    mutationFn: () => catalogApi.withdraw(courseId),
    onSuccess: (updated) => {
      setCourseData(queryClient, updated);
      void queryClient.invalidateQueries({ queryKey: catalogKeys.course(courseId) });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.course(courseId), exact: true });
    },
  });

  function navigate(target: BuilderTarget) {
    setTab(target.tab);
    // Focus once the tab is shown (the state update renders synchronously after this handler).
    setTimeout(() => {
      if (target.tab === 'details') {
        document.getElementById(`course-${target.field}`)?.focus();
        return;
      }
      if (target.lectureId) {
        document.getElementById(`lecture-${target.lectureId}`)?.focus();
        setOpenLectureId(target.lectureId);
        return;
      }
      if (target.sectionId) {
        document.getElementById(`section-${target.sectionId}`)?.focus();
        return;
      }
      document.getElementById('curriculum-heading')?.focus();
    }, 0);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = BUILDER_TABS.indexOf(tab);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % BUILDER_TABS.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + BUILDER_TABS.length) % BUILDER_TABS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = BUILDER_TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const nextTab = BUILDER_TABS[next]!;
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  if (course.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading the course" className="grid gap-4">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (course.isError) {
    if (hasCode(course.error, ErrorCode.CourseNotFound) || hasCode(course.error, ErrorCode.NotFound)) {
      return (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Course not found</AlertTitle>
          <AlertDescription>
            <p>
              This course does not exist or is not yours.{' '}
              <Link href="/courses" className="font-medium underline underline-offset-4">
                Back to my courses
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      );
    }
    return <QueryError error={course.error} onRetry={() => void course.refetch()} />;
  }

  const data = course.data;
  const readOnly = data.locked || data.status === 'ARCHIVED' || data.status === 'IN_REVIEW';
  const lecture =
    openLectureId && curriculum.data
      ? (curriculum.data.sections.flatMap((s) => s.lectures).find((l) => l.id === openLectureId) ?? null)
      : null;
  const issueCount = data.readiness.issues.length;
  const withdrawError = withdraw.isError ? problemMessage(withdraw.error) : null;

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link href="/courses" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← My courses
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">{data.title}</h1>
          <CourseBadge badge={data.badge} />
          {data.hasUnpublishedChanges && data.liveRevision ? (
            <Badge variant="outline">Unpublished changes</Badge>
          ) : null}
        </div>
      </div>

      <LockBanner
        course={data}
        onWithdraw={() => withdraw.mutate()}
        withdrawing={withdraw.isPending}
        error={withdrawError}
      />

      <div role="tablist" aria-label="Course builder" className="flex gap-1 border-b">
        {BUILDER_TABS.map((value) => (
          <button
            key={value}
            ref={(node) => {
              tabRefs.current[value] = node;
            }}
            type="button"
            role="tab"
            id={`tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={onTabKeyDown}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
              tab === value
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {TAB_LABELS[value]}
            {value === 'review' && issueCount > 0 && !data.locked ? (
              <span className="ml-2 rounded-full bg-muted px-1.5 text-xs" aria-label={`${issueCount} items left`}>
                {issueCount}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="panel-details" aria-labelledby="tab-details" hidden={tab !== 'details'}>
        <DetailsTab course={data} readOnly={readOnly} />
      </div>
      <div role="tabpanel" id="panel-curriculum" aria-labelledby="tab-curriculum" hidden={tab !== 'curriculum'}>
        {curriculum.isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : curriculum.isError ? (
          <QueryError error={curriculum.error} onRetry={() => void curriculum.refetch()} />
        ) : (
          <CurriculumTab
            course={data}
            curriculum={curriculum.data}
            readOnly={readOnly}
            onOpenLecture={setOpenLectureId}
          />
        )}
      </div>
      <div role="tabpanel" id="panel-review" aria-labelledby="tab-review" hidden={tab !== 'review'}>
        <ReviewTab
          course={data}
          curriculum={curriculum.data}
          onNavigate={navigate}
          onWithdraw={() => withdraw.mutate()}
          withdrawing={withdraw.isPending}
          withdrawError={withdrawError}
        />
      </div>

      <LectureDrawer
        courseId={courseId}
        lecture={lecture}
        readOnly={readOnly}
        onClose={() => setOpenLectureId(null)}
      />
    </div>
  );
}
