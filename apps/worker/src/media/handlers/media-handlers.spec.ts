import type { EventEnvelope } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { FAKE_TRX, fakeConfig, RecordingMailer } from '../../identity/testing/identity-mail.fakes';
import { NonRetryableError } from '../../messaging';
import { type UserContact, UserContactReader } from '../../shared/mail/user-contact.reader';
import { MediaLinks } from '../mail/media-links';
import {
  type FailedAssetContext,
  FailedAssetContextReader,
} from '../persistence/failed-asset-context.reader';
import { TranscodeJobQueue } from '../persistence/transcode-job-queue';
import { ProcessingFailedMailerHandler } from './processing-failed-mailer.handler';
import { TranscodeEnqueuerHandler } from './transcode-enqueuer.handler';

const ASSET = '0199c8a0-0000-7000-8000-0000000000a1';
const OWNER = '0199c8a0-0000-7000-8000-000000000001';
const COURSE = '0199c8a0-0000-7000-8000-0000000000c1';
const EVENT = '0199c8a0-0000-7000-8000-0000000000e1';
const NOW = '2026-10-10T10:00:00.000Z';

function envelope(eventType: string, payload: unknown, version = 1): EventEnvelope {
  return {
    eventId: EVENT,
    eventType,
    aggregateType: 'media.asset',
    aggregateId: ASSET,
    occurredAt: NOW,
    version,
    payload,
  };
}

const uploaded = (overrides: Record<string, unknown> = {}, version = 1): EventEnvelope =>
  envelope(
    'MediaUploaded',
    {
      assetId: ASSET,
      ownerId: OWNER,
      purpose: 'LECTURE_VIDEO',
      declaredContentType: 'video/mp4',
      sizeBytes: 1024,
      uploadedAt: NOW,
      ...overrides,
    },
    version,
  );

const failed = (overrides: Record<string, unknown> = {}, version = 1): EventEnvelope =>
  envelope(
    'MediaFailed',
    {
      assetId: ASSET,
      ownerId: OWNER,
      purpose: 'LECTURE_VIDEO',
      failureCode: 'TOO_LONG',
      attempts: 1,
      failedAt: NOW,
      ...overrides,
    },
    version,
  );

/** An in-memory job table with the SQL's ON CONFLICT semantics. */
class FakeQueue extends TranscodeJobQueue {
  readonly jobs = new Set<string>();
  readonly calls: { trx: Transaction<DB>; assetId: string }[] = [];
  constructor() {
    super(fakeConfig({ TRANSCODER_MAX_ATTEMPTS: 3 }));
  }
  override async enqueue(trx: Transaction<DB>, assetId: string): Promise<boolean> {
    this.calls.push({ trx, assetId });
    if (this.jobs.has(assetId)) return false;
    this.jobs.add(assetId);
    return true;
  }
}

class FakeContacts extends UserContactReader {
  constructor(private readonly contact: UserContact | null) {
    super();
  }
  override async find(): Promise<UserContact | null> {
    return this.contact;
  }
}

class FakeAssets extends FailedAssetContextReader {
  constructor(private readonly context: FailedAssetContext) {
    super();
  }
  override async find(): Promise<FailedAssetContext> {
    return this.context;
  }
}

describe('TranscodeEnqueuerHandler', () => {
  it('enqueues the asset in the handler transaction; a second delivery inserts nothing', async () => {
    const queue = new FakeQueue();
    const handler = new TranscodeEnqueuerHandler(queue);
    await handler.handle(uploaded(), FAKE_TRX);
    await handler.handle(uploaded(), FAKE_TRX);
    expect(queue.calls).toEqual([
      { trx: FAKE_TRX, assetId: ASSET },
      { trx: FAKE_TRX, assetId: ASSET },
    ]);
    expect([...queue.jobs]).toEqual([ASSET]);
  });

  it('dead-letters an unsupported version and a payload that breaks the contract', async () => {
    const queue = new FakeQueue();
    const handler = new TranscodeEnqueuerHandler(queue);
    await expect(handler.handle(uploaded({}, 2), FAKE_TRX)).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    await expect(
      handler.handle(uploaded({ assetId: 'not-a-uuid' }), FAKE_TRX),
    ).rejects.toBeInstanceOf(ZodError);
    expect(queue.calls).toEqual([]);
  });
});

describe('ProcessingFailedMailerHandler', () => {
  const links = new MediaLinks(fakeConfig());
  const jane: UserContact = { email: 'jane@example.com', displayName: 'Jane <Doe>' };
  let mailer: RecordingMailer;

  beforeEach(() => {
    mailer = new RecordingMailer();
  });

  it('mails the owner the failure label and the builder link of the lecture that uses the asset', async () => {
    const assets = new FakeAssets({
      originalFilename: 'intro<1>.mp4',
      placement: {
        kind: 'lecture',
        courseId: COURSE,
        courseTitle: 'Rust & You',
        lectureTitle: 'Welcome',
      },
    });
    await new ProcessingFailedMailerHandler(new FakeContacts(jane), assets, mailer, links).handle(
      failed(),
      FAKE_TRX,
    );
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0];
    expect(mail).toMatchObject({
      to: 'jane@example.com',
      subject: "We couldn't process your video",
      messageId: `<${EVENT}@udemy.local>`,
    });
    expect(mail?.text).toContain(
      'What went wrong: The video is longer than the maximum of 4 hours.',
    );
    expect(mail?.text).toContain(
      `Open the course builder: http://localhost:3001/courses/${COURSE}`,
    );
    expect(mail?.html).toContain('&quot;intro&lt;1&gt;.mp4&quot;');
    expect(mail?.html).toContain('&quot;Rust &amp; You&quot;');
  });

  it('links to the course of a thumbnail, and to "My courses" when the asset is unattached', async () => {
    await new ProcessingFailedMailerHandler(
      new FakeContacts(jane),
      new FakeAssets({
        originalFilename: 'cover.png',
        placement: { kind: 'thumbnail', courseId: COURSE, courseTitle: 'Rust' },
      }),
      mailer,
      links,
    ).handle(failed({ purpose: 'COURSE_THUMBNAIL', failureCode: 'INVALID_MEDIA' }), FAKE_TRX);
    await new ProcessingFailedMailerHandler(
      new FakeContacts(jane),
      new FakeAssets({ originalFilename: null, placement: null }),
      mailer,
      links,
    ).handle(failed({ failureCode: 'CRASHED' }), FAKE_TRX);
    expect(mailer.sent[0]?.subject).toBe("We couldn't process your course image");
    expect(mailer.sent[0]?.text).toContain('It is the course image of "Rust".');
    expect(mailer.sent[0]?.text).toContain(`/courses/${COURSE}`);
    expect(mailer.sent[1]?.text).toContain('We could not process your video.');
    expect(mailer.sent[1]?.text).toContain('Open my courses: http://localhost:3001/courses\n');
  });

  it('skips quietly when the owner no longer exists, and dead-letters an unknown failure code', async () => {
    const assets = new FakeAssets({ originalFilename: 'a.mp4', placement: null });
    await new ProcessingFailedMailerHandler(new FakeContacts(null), assets, mailer, links).handle(
      failed(),
      FAKE_TRX,
    );
    expect(mailer.sent).toHaveLength(0);
    await expect(
      new ProcessingFailedMailerHandler(new FakeContacts(jane), assets, mailer, links).handle(
        failed({ failureCode: 'EXPLODED' }),
        FAKE_TRX,
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
