import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@udemy/contracts';
import { eventMessageId, SmtpMailer } from '@udemy/nest-common/mail';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeConfig } from '../identity/testing/identity-mail.fakes';
import type { RegisteredEventHandler } from '../messaging/event-handler.interface';
import { IdempotentEventProcessor } from '../messaging/idempotency/idempotent-event-processor';
import { UserContactReader } from '../shared/mail/user-contact.reader';
import { seedDraftCourse, seedVideoAsset, seedVideoLecture } from '../testing/catalog-fixtures';
import {
  deleteMail,
  deleteTestData,
  exactlyMails,
  insertTestUser,
  itSmtpHost,
  itSmtpPort,
  useIntegrationStack,
} from '../testing/integration';
import { ProcessingFailedMailerHandler } from './handlers/processing-failed-mailer.handler';
import { TranscodeEnqueuerHandler } from './handlers/transcode-enqueuer.handler';
import { MediaLinks } from './mail/media-links';
import { FailedAssetContextReader } from './persistence/failed-asset-context.reader';
import { TranscodeJobQueue } from './persistence/transcode-job-queue';

/**
 * The `media.asset` consumers with their real adapters: Kysely against the dev Postgres, SMTP to
 * Mailpit and the real idempotent processor. Events are built in memory (never written to the
 * outbox), with `it.`-prefixed consumer names, so a running worker never sees them.
 */
describe('media.asset consumers (integration: Postgres + Mailpit)', () => {
  const it_ = useIntegrationStack();
  const userIds: string[] = [];
  const emails: string[] = [];
  const eventIds: string[] = [];
  let mailer: SmtpMailer | undefined;
  let enqueuer: RegisteredEventHandler;
  let failedMailer: RegisteredEventHandler;
  let processor: IdempotentEventProcessor;

  beforeAll(() => {
    if (it_.unavailableReason !== undefined) return;
    mailer = new SmtpMailer({
      host: itSmtpHost(),
      port: itSmtpPort(),
      from: 'Udemy Clone <no-reply@udemy.local>',
      pool: false,
    });
    enqueuer = {
      topic: 'media.asset',
      eventType: 'MediaUploaded',
      consumerName: 'it.media.transcode-enqueuer',
      handler: new TranscodeEnqueuerHandler(new TranscodeJobQueue()),
    };
    failedMailer = {
      topic: 'media.asset',
      eventType: 'MediaFailed',
      consumerName: 'it.media.processing-failed-mailer',
      handler: new ProcessingFailedMailerHandler(
        new UserContactReader(),
        new FailedAssetContextReader(),
        mailer,
        new MediaLinks(fakeConfig()),
      ),
    };
    processor = new IdempotentEventProcessor(it_.db);
  });

  afterAll(async () => {
    mailer?.close();
    if (it_.unavailableReason !== undefined) return;
    if (eventIds.length > 0) {
      await it_.db.deleteFrom('outbox.processedEvents').where('eventId', 'in', eventIds).execute();
    }
    await deleteTestData(it_.db, userIds);
    await Promise.all(emails.map((e) => deleteMail(e)));
  });

  async function owner(): Promise<{ id: string; email: string }> {
    const user = await insertTestUser(it_.db, {
      tag: 'media',
      displayName: 'Owner <IT>',
      role: 'INSTRUCTOR',
    });
    userIds.push(user.id);
    emails.push(user.email);
    return user;
  }

  function envelope(eventType: string, assetId: string, payload: object): EventEnvelope {
    const eventId = randomUUID();
    eventIds.push(eventId);
    return {
      eventId,
      eventType,
      aggregateType: 'media.asset',
      aggregateId: assetId,
      occurredAt: new Date().toISOString(),
      version: 1,
      payload,
    };
  }

  const jobCount = async (assetId: string): Promise<number> =>
    (
      await it_.db
        .selectFrom('media.transcodeJobs')
        .select('assetId')
        .where('assetId', '=', assetId)
        .execute()
    ).length;

  it('MediaUploaded -> exactly one transcode job; redelivery and a re-emitted event add nothing', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const user = await owner();
    const assetId = randomUUID();
    await seedVideoAsset(it_.db, { id: assetId, ownerId: user.id, stage: 'UPLOADED' });
    const payload = {
      assetId,
      ownerId: user.id,
      purpose: 'LECTURE_VIDEO',
      declaredContentType: 'video/mp4',
      sizeBytes: 1000,
      uploadedAt: new Date().toISOString(),
    };
    const event = envelope('MediaUploaded', assetId, payload);

    await expect(processor.process(enqueuer, event)).resolves.toBe('processed');
    await expect(processor.process(enqueuer, event)).resolves.toBe('duplicate');
    expect(await jobCount(assetId)).toBe(1);

    // A second MediaUploaded for the same asset (new event id): claimed, but ON CONFLICT inserts nothing.
    await expect(
      processor.process(enqueuer, envelope('MediaUploaded', assetId, payload)),
    ).resolves.toBe('processed');
    expect(await jobCount(assetId)).toBe(1);
  }, 30_000);

  it('MediaUploaded for an asset that is not UPLOADED queues nothing', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const user = await owner();
    const assetId = randomUUID();
    await seedVideoAsset(it_.db, { id: assetId, ownerId: user.id, stage: 'FAILED' });
    const event = envelope('MediaUploaded', assetId, {
      assetId,
      ownerId: user.id,
      purpose: 'LECTURE_VIDEO',
      declaredContentType: 'video/mp4',
      sizeBytes: 1000,
      uploadedAt: new Date().toISOString(),
    });
    await expect(processor.process(enqueuer, event)).resolves.toBe('processed');
    expect(await jobCount(assetId)).toBe(0);
  }, 30_000);

  it('MediaFailed -> one mail to the owner with the failure label and the lecture builder link', async (ctx) => {
    it_.skipIfUnavailable(ctx);
    const user = await owner();
    const assetId = randomUUID();
    await seedVideoAsset(it_.db, {
      id: assetId,
      ownerId: user.id,
      stage: 'FAILED',
      filename: 'intro <final>.mp4',
    });
    const { courseId } = await seedDraftCourse(it_.db, { ownerId: user.id, title: 'Rust & Wasm' });
    await seedVideoLecture(it_.db, { courseId, title: 'Welcome', mediaAssetId: assetId });
    const event = envelope('MediaFailed', assetId, {
      assetId,
      ownerId: user.id,
      purpose: 'LECTURE_VIDEO',
      failureCode: 'TOO_LONG',
      attempts: 1,
      failedAt: new Date().toISOString(),
    });

    await expect(processor.process(failedMailer, event)).resolves.toBe('processed');
    await expect(processor.process(failedMailer, event)).resolves.toBe('duplicate');

    const mails = await exactlyMails(user.email, 1);
    const mail = mails[0];
    expect(mail?.Subject).toBe("We couldn't process your video");
    expect(`<${mail?.MessageID}>`).toBe(eventMessageId(event.eventId));
    expect(mail?.Text).toContain(
      'We could not process "intro <final>.mp4". It belongs to the lecture "Welcome" in your course "Rust & Wasm".',
    );
    expect(mail?.Text).toContain(
      'What went wrong: The video is longer than the maximum of 4 hours.',
    );
    expect(mail?.Text).toContain(
      `Open the course builder: http://localhost:3001/courses/${courseId}`,
    );
    expect(mail?.HTML).toContain(`href="http://localhost:3001/courses/${courseId}"`);
    expect(mail?.HTML).toContain('&quot;intro &lt;final&gt;.mp4&quot;');
    expect(mail?.HTML).toContain('Hi Owner &lt;IT&gt;,');
  }, 30_000);
});
