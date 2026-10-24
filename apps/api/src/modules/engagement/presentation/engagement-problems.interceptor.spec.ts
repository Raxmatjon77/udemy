import { type CallHandler, type ExecutionContext, HttpException } from '@nestjs/common';
import { ErrorCode } from '@udemy/contracts';
import { lastValueFrom, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AnnouncementLimitExceeded, QuestionNotFound } from '../domain/engagement.errors';
import { assertMarkdownAllowed } from '../domain/markdown';
import { EngagementProblemsInterceptor } from './engagement-problems.interceptor';

describe('EngagementProblemsInterceptor (RFC 7807 extension members)', () => {
  const run = async (error: unknown): Promise<unknown> => {
    const next: CallHandler = { handle: () => throwError(() => error) };
    return lastValueFrom(
      new EngagementProblemsInterceptor().intercept({} as ExecutionContext, next),
    ).catch((e: unknown) => e);
  };

  it('announcement_limit_exceeded carries retryAt', async () => {
    const retryAt = new Date('2026-11-20T10:00:00.000Z');
    const mapped = (await run(new AnnouncementLimitExceeded(retryAt))) as HttpException;
    expect(mapped).toBeInstanceOf(HttpException);
    expect(mapped.getStatus()).toBe(422);
    expect(mapped.getResponse()).toMatchObject({
      code: ErrorCode.AnnouncementLimitExceeded,
      retryAt: '2026-11-20T10:00:00.000Z',
    });
  });

  it('markdown_not_allowed carries structured issues and field errors', async () => {
    let error: unknown;
    try {
      assertMarkdownAllowed('bodyMd', 'hi <b>there</b>');
    } catch (e) {
      error = e;
    }
    const mapped = (await run(error)) as HttpException;
    expect(mapped.getStatus()).toBe(422);
    const body = mapped.getResponse() as { code: string; issues: unknown[]; errors: unknown[] };
    expect(body.code).toBe(ErrorCode.MarkdownNotAllowed);
    expect(body.issues[0]).toMatchObject({ path: 'bodyMd', kind: expect.any(String) });
    expect(body.errors[0]).toMatchObject({ path: 'bodyMd' });
  });

  it('other errors pass through unchanged', async () => {
    const other = new QuestionNotFound();
    expect(await run(other)).toBe(other);
  });
});
