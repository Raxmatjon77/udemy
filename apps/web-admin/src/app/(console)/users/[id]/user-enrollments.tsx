'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  AdminEnrollmentResponseSchema,
  AdminMoneyReasonSchema,
  AdminRevokeEnrollmentRequestSchema,
  AdminUserEnrollmentsSchema,
  ErrorCode,
  type AdminEnrollment,
} from '@udemy/contracts';
import { Badge } from '@udemy/ui/components/badge';
import { Button } from '@udemy/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@udemy/ui/components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@udemy/ui/components/dialog';
import { FormField } from '@udemy/ui/components/form-field';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@udemy/ui/components/table';
import { Textarea } from '@udemy/ui/components/textarea';

import { FormAlert } from '@/components/form-alert';
import { QueryError } from '@/components/query-error';
import { ReasonDialog } from '@/components/reason-dialog';
import { SearchPicker, type PickerOption } from '@/components/search-picker';
import { SubmitButton } from '@/components/submit-button';
import { TableSkeleton } from '@/components/table-skeleton';
import { api } from '@/lib/api';
import {
  ENROLLMENT_ACTION_LABEL,
  ENROLLMENT_REVOKE_REASON_LABEL,
  ENROLLMENT_SOURCE_LABEL,
  ENROLLMENT_STATUS_LABEL,
} from '@/lib/commerce';
import { applyServerError } from '@/lib/form';
import { formatDateTime } from '@/lib/format';
import { searchCourses } from '@/lib/pickers';
import { hasCode, type MessageOverrides } from '@/lib/problem';
import { queryKeys } from '@/lib/queries';
import { formResolver } from '@/lib/zod-messages';

const GrantFormSchema = z.object({
  courseId: z.string().min(1, 'Choose a course.'),
  reason: AdminMoneyReasonSchema,
});

const MESSAGES: MessageOverrides = {
  [ErrorCode.InvalidStateTransition]:
    'This enrollment was already revoked. The list was refreshed.',
  [ErrorCode.CourseNotFound]: 'This course no longer exists.',
};

function GrantDialog({ userId, userName }: { userId: string; userName: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [course, setCourse] = useState<PickerOption | null>(null);
  const { register, handleSubmit, formState, setError, setValue, reset, clearErrors } = useForm({
    resolver: formResolver(GrantFormSchema),
    defaultValues: { courseId: '', reason: '' },
  });
  const pending = formState.isSubmitting;

  function close() {
    setOpen(false);
    setCourse(null);
    reset();
  }

  const submit = handleSubmit(async ({ courseId, reason }) => {
    try {
      await api('/admin/enrollments', {
        method: 'POST',
        json: { userId, courseId, reason },
        schema: AdminEnrollmentResponseSchema,
      });
      close();
      void queryClient.invalidateQueries({ queryKey: queryKeys.userEnrollments(userId) });
    } catch (error) {
      if (hasCode(error, ErrorCode.AlreadyEnrolled)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.userEnrollments(userId) });
      }
      applyServerError(setError, error, {
        fields: ['courseId', 'reason'],
        codeFields: {
          [ErrorCode.AlreadyEnrolled]: 'courseId',
          [ErrorCode.CourseNotFound]: 'courseId',
        },
        messages: MESSAGES,
      });
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) setOpen(true);
        else close();
      }}
    >
      <DialogTrigger asChild>
        <Button>Grant enrollment</Button>
      </DialogTrigger>
      <DialogContent>
        <form noValidate onSubmit={submit} className="grid gap-4" aria-busy={pending}>
          <DialogHeader>
            <DialogTitle>Grant {userName} access to a course</DialogTitle>
            <DialogDescription>
              The enrollment is free of charge (source: admin) and starts immediately.
            </DialogDescription>
          </DialogHeader>
          <FormAlert message={formState.errors.root?.server?.message} />
          <input type="hidden" {...register('courseId')} />
          <SearchPicker
            id="grant-course"
            label="Course"
            placeholder="Course title"
            value={course}
            onChange={(option) => {
              setCourse(option);
              setValue('courseId', option?.id ?? '');
              if (option) clearErrors('courseId');
            }}
            search={searchCourses}
            queryKey={queryKeys.pickerCourses}
            error={formState.errors.courseId?.message}
          />
          <FormField
            id="grant-reason"
            label="Reason"
            description="10 to 2000 characters. Stored on the enrollment and in the audit trail."
            error={formState.errors.reason?.message}
          >
            {(field) => (
              <Textarea
                {...field}
                rows={4}
                maxLength={2000}
                aria-required
                {...register('reason')}
              />
            )}
          </FormField>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton pending={pending} pendingLabel="Granting…">
              Grant enrollment
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevokeAction({ enrollment, userId }: { enrollment: AdminEnrollment; userId: string }) {
  const queryClient = useQueryClient();
  const title = enrollment.course.title ?? 'this course';
  const revoke = useMutation({
    mutationFn: (reason: string) =>
      api(`/admin/enrollments/${encodeURIComponent(enrollment.id)}/revoke`, {
        method: 'POST',
        json: { reason },
        schema: AdminEnrollmentResponseSchema,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.userEnrollments(userId) }),
  });
  return (
    <ReasonDialog
      trigger={
        <Button size="sm" variant="outline" aria-label={`Revoke ${title}`}>
          Revoke
        </Button>
      }
      title={`Revoke access to ${title}?`}
      description={
        enrollment.source === 'ORDER'
          ? 'The student loses access immediately. This does not refund the purchase; refund the order line instead if money should go back.'
          : 'The student loses access immediately.'
      }
      label="Reason"
      fieldDescription="10 to 2000 characters. Stored on the enrollment and in the audit trail."
      schema={AdminRevokeEnrollmentRequestSchema}
      confirmLabel="Revoke"
      pendingLabel="Revoking…"
      destructive
      maxLength={2000}
      messages={MESSAGES}
      onConfirm={(reason) => revoke.mutateAsync(reason ?? '')}
    />
  );
}

export function UserEnrollments({ userId, userName }: { userId: string; userName: string }) {
  const enrollments = useQuery({
    queryKey: queryKeys.userEnrollments(userId),
    queryFn: () =>
      api(`/admin/users/${encodeURIComponent(userId)}/enrollments`, {
        schema: AdminUserEnrollmentsSchema,
      }),
  });

  let body;
  if (enrollments.isPending) {
    body = <TableSkeleton label="Loading enrollments" rows={3} />;
  } else if (!enrollments.data) {
    body = <QueryError error={enrollments.error} onRetry={() => void enrollments.refetch()} />;
  } else if (enrollments.data.items.length === 0) {
    body = <p className="text-sm text-muted-foreground">This user has no enrollments.</p>;
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Course</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Granted</TableHead>
            <TableHead>Revoked</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {enrollments.data.items.map((enrollment) => (
            <TableRow key={enrollment.id} className="align-top">
              <TableCell>
                <div className="grid gap-1">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {enrollment.course.title ?? 'Deleted course'}
                    {enrollment.course.archived ? <Badge variant="outline">Archived</Badge> : null}
                  </span>
                  {enrollment.transitions.length > 0 ? (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">
                        History ({enrollment.transitions.length})
                      </summary>
                      <ol className="mt-1 grid gap-1">
                        {enrollment.transitions.map((t) => (
                          <li key={t.id}>
                            <time dateTime={t.occurredAt}>{formatDateTime(t.occurredAt)}</time>:{' '}
                            {ENROLLMENT_ACTION_LABEL[t.action]}
                            {t.source
                              ? ` (${ENROLLMENT_SOURCE_LABEL[t.source].toLowerCase()})`
                              : ''}
                            {t.reason ? ` · ${t.reason}` : ''}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>{ENROLLMENT_SOURCE_LABEL[enrollment.source]}</TableCell>
              <TableCell>
                <Badge variant={enrollment.status === 'ACTIVE' ? 'default' : 'outline'}>
                  {ENROLLMENT_STATUS_LABEL[enrollment.status]}
                </Badge>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <time dateTime={enrollment.grantedAt}>{formatDateTime(enrollment.grantedAt)}</time>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {enrollment.revokedAt ? (
                  <>
                    <time dateTime={enrollment.revokedAt}>
                      {formatDateTime(enrollment.revokedAt)}
                    </time>
                    {enrollment.revokeReason ? (
                      <div className="text-xs text-muted-foreground">
                        {ENROLLMENT_REVOKE_REASON_LABEL[enrollment.revokeReason]}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right">
                {enrollment.status === 'ACTIVE' ? (
                  <RevokeAction enrollment={enrollment} userId={userId} />
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1.5">
          <CardTitle asChild>
            <h2>Enrollments</h2>
          </CardTitle>
          <CardDescription>
            Every course this user can (or could) access, with how they got it.
          </CardDescription>
        </div>
        <GrantDialog userId={userId} userName={userName} />
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
