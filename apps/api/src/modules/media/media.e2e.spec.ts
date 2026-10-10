// Must stay the first import: AppModule validates process.env when it is imported.
import './testing/apply-media-e2e-env';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AssetViewSchema,
  type AuthResult,
  ErrorCode,
  InitiateUploadResponseSchema,
  PresignPartsResponseSchema,
  UploadIncompleteProblemSchema,
  UploadStatusSchema,
} from '@udemy/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type BearerClient,
  type E2eHarness,
  expectProblem,
  type SignedUpUser,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { deleteMediaTestData, useIntegrationS3 } from './testing/media-it';

/*
 * Media endpoints (design §8) through the REAL AppModule: global guards in production order,
 * validation, the problem+json filter, real Postgres, Redis and MinIO. Covers the auth matrix
 * (owner vs other instructor -> 404, admin reads any, student 403, app confinement) and the
 * upload flow over HTTP with real presigned part PUTs.
 */
const V1 = '/api/v1';

interface Fixtures {
  instructorA: SignedUpUser;
  instructorB: SignedUpUser;
  student: SignedUpUser;
  admin: SignedUpUser;
  tokens: { a: AuthResult; b: AuthResult; student: AuthResult; admin: AuthResult };
  /** An UPLOADED asset of instructor A. */
  assetOfA: string;
  /** An UPLOADING (nothing uploaded) asset of instructor A. */
  pendingOfA: string;
}

describe('media endpoints (e2e: real AppModule, Postgres, Redis, MinIO)', () => {
  const e2e: E2eHarness = useE2eApp();
  const s3 = useIntegrationS3();
  let fx: Fixtures | undefined;

  const fixtures = (): Fixtures => {
    if (fx === undefined) throw new Error('fixtures not created (infra unavailable?)');
    return fx;
  };
  const available = (): boolean =>
    e2e.pg.available && e2e.redis.available && s3.unavailableReason === undefined;

  const instructorA = (): BearerClient => e2e.as('instructor', fixtures().tokens.a.accessToken);
  const instructorB = (): BearerClient => e2e.as('instructor', fixtures().tokens.b.accessToken);
  const admin = (): BearerClient => e2e.as('admin', fixtures().tokens.admin.accessToken);
  const student = (): BearerClient => e2e.as('student', fixtures().tokens.student.accessToken);

  /** POST /media/uploads -> part-urls -> PUTs -> complete, all over HTTP. */
  async function uploadOverHttp(client: BearerClient, bytes: Buffer): Promise<string> {
    const init = await client
      .post(`${V1}/media/uploads`)
      .send({
        purpose: 'LECTURE_VIDEO',
        filename: 'lesson.mp4',
        contentType: 'video/mp4',
        sizeBytes: bytes.length,
      })
      .expect(201);
    const { assetId, partSize, partCount } = InitiateUploadResponseSchema.parse(init.body);
    expect(init.headers.location).toBe(`/api/v1/media/uploads/${assetId}`);

    const parts = await client
      .post(`${V1}/media/uploads/${assetId}/part-urls`)
      .send({ partNumbers: Array.from({ length: partCount }, (_, i) => i + 1) })
      .expect(200);
    expect(parts.headers['cache-control']).toBe('no-store');
    for (const { partNumber, url } of PresignPartsResponseSchema.parse(parts.body).urls) {
      const start = (partNumber - 1) * partSize;
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(bytes.subarray(start, start + partSize)),
      });
      expect(res.status).toBe(200);
    }
    const done = await client.post(`${V1}/media/uploads/${assetId}/complete`).send({}).expect(200);
    expect(AssetViewSchema.parse(done.body)).toMatchObject({ id: assetId, status: 'UPLOADED' });
    return assetId;
  }

  beforeAll(async () => {
    if (!available()) return;
    const adminUser = await e2e.bootstrapAdmin();
    const a = await e2e.signup();
    const b = await e2e.signup();
    const studentUser = await e2e.signup();
    for (const u of [a, b, studentUser]) await e2e.verifyEmailViaSql(u.userId);
    await e2e.promoteToInstructor(a.userId, adminUser.userId);
    await e2e.promoteToInstructor(b.userId, adminUser.userId);
    const tokens = {
      a: await e2e.login('instructor', a.email),
      b: await e2e.login('instructor', b.email),
      student: await e2e.login('student', studentUser.email),
      admin: await e2e.login('admin', adminUser.email),
    };
    fx = {
      instructorA: a,
      instructorB: b,
      student: studentUser,
      admin: adminUser,
      tokens,
      assetOfA: '',
      pendingOfA: '',
    };
    fx.assetOfA = await uploadOverHttp(instructorA(), randomBytes(4096));
    const pending = await instructorA()
      .post(`${V1}/media/uploads`)
      .send({
        purpose: 'COURSE_THUMBNAIL',
        filename: 'c.png',
        contentType: 'image/png',
        sizeBytes: 10,
      })
      .expect(201);
    fx.pendingOfA = InitiateUploadResponseSchema.parse(pending.body).assetId;
  });

  // Registered after useE2eApp/useIntegrationS3, so it runs BEFORE their teardown (users are
  // deleted by the harness; the S3 client is still open).
  afterAll(async () => {
    if (fx === undefined || !available()) return;
    await deleteMediaTestData(
      e2e.pg.db,
      [fx.instructorA.userId, fx.instructorB.userId, fx.student.userId, fx.admin.userId],
      { storage: s3.storage, redis: e2e.redis.redis },
    );
  });

  const skip = (ctx: { skip(condition: boolean, note?: string): void }): void => {
    e2e.skip(ctx);
    s3.skipIfUnavailable(ctx);
  };

  describe('upload flow over HTTP', () => {
    it('initiate -> part URLs -> PUT -> status -> complete (idempotent) -> asset', async (ctx) => {
      skip(ctx);
      const bytes = randomBytes(8 * 1024 * 1024 + 10); // two parts
      const init = await instructorA()
        .post(`${V1}/media/uploads`)
        .send({
          purpose: 'LECTURE_VIDEO',
          filename: 'two.mp4',
          contentType: 'video/mp4',
          sizeBytes: bytes.length,
        })
        .expect(201);
      const { assetId } = InitiateUploadResponseSchema.parse(init.body);
      const parts = await instructorA()
        .post(`${V1}/media/uploads/${assetId}/part-urls`)
        .send({ partNumbers: [1] })
        .expect(200);
      const [first] = PresignPartsResponseSchema.parse(parts.body).urls;
      expect(
        (
          await fetch(first?.url ?? '', {
            method: 'PUT',
            body: new Uint8Array(bytes.subarray(0, 8 * 1024 * 1024)),
          })
        ).status,
      ).toBe(200);

      const status = await instructorA().get(`${V1}/media/uploads/${assetId}`).expect(200);
      expect(UploadStatusSchema.parse(status.body)).toMatchObject({
        status: 'UPLOADING',
        partCount: 2,
        uploadedParts: [{ partNumber: 1, size: 8 * 1024 * 1024 }],
      });

      // Part 2 missing: 409 upload_incomplete with the contract's missingParts member.
      const incomplete = await instructorA()
        .post(`${V1}/media/uploads/${assetId}/complete`)
        .send({});
      expectProblem(incomplete, 409, ErrorCode.UploadIncomplete);
      expect(UploadIncompleteProblemSchema.parse(incomplete.body).missingParts).toEqual([2]);

      const second = await instructorA()
        .post(`${V1}/media/uploads/${assetId}/part-urls`)
        .send({ partNumbers: [2] })
        .expect(200);
      const url2 = PresignPartsResponseSchema.parse(second.body).urls[0]?.url ?? '';
      expect(
        (
          await fetch(url2, {
            method: 'PUT',
            body: new Uint8Array(bytes.subarray(8 * 1024 * 1024)),
          })
        ).status,
      ).toBe(200);

      const done = await instructorA()
        .post(`${V1}/media/uploads/${assetId}/complete`)
        .send({})
        .expect(200);
      const again = await instructorA()
        .post(`${V1}/media/uploads/${assetId}/complete`)
        .send({})
        .expect(200);
      expect(again.body).toEqual(done.body);
      expect(AssetViewSchema.parse(done.body)).toMatchObject({
        id: assetId,
        ownerId: fixtures().instructorA.userId,
        status: 'UPLOADED',
        sizeBytes: bytes.length,
        originalFilename: 'two.mp4',
      });
      const asset = await instructorA().get(`${V1}/media/assets/${assetId}`).expect(200);
      expect(asset.body).toEqual(done.body);
    });

    it('maps policy errors: 422 unsupported_media_type / upload_too_large, 400 shape errors', async (ctx) => {
      skip(ctx);
      const svg = await instructorA().post(`${V1}/media/uploads`).send({
        purpose: 'COURSE_THUMBNAIL',
        filename: 'x.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 10,
      });
      expectProblem(svg, 422, ErrorCode.UnsupportedMediaType);
      const big = await instructorA()
        .post(`${V1}/media/uploads`)
        .send({
          purpose: 'COURSE_THUMBNAIL',
          filename: 'x.png',
          contentType: 'image/png',
          sizeBytes: 6 * 1024 * 1024,
        });
      expectProblem(big, 422, ErrorCode.UploadTooLarge);
      const bad = await instructorA()
        .post(`${V1}/media/uploads`)
        .send({ purpose: 'AVATAR', filename: 'x.png', contentType: 'image/png', sizeBytes: 1 });
      expectProblem(bad, 400, ErrorCode.ValidationFailed);
      const parts = await instructorA()
        .post(`${V1}/media/uploads/${fixtures().pendingOfA}/part-urls`)
        .send({ partNumbers: [2] });
      expectProblem(parts, 422, ErrorCode.ValidationFailed);
    });

    it('abort: 204, then 409 upload_not_in_progress', async (ctx) => {
      skip(ctx);
      const init = await instructorA()
        .post(`${V1}/media/uploads`)
        .send({
          purpose: 'LECTURE_RESOURCE',
          filename: 'n.pdf',
          contentType: 'application/pdf',
          sizeBytes: 10,
        })
        .expect(201);
      const { assetId } = InitiateUploadResponseSchema.parse(init.body);
      await instructorA().delete(`${V1}/media/uploads/${assetId}`).expect(204);
      expectProblem(
        await instructorA().delete(`${V1}/media/uploads/${assetId}`),
        409,
        ErrorCode.UploadNotInProgress,
      );
      expectProblem(
        await instructorA()
          .post(`${V1}/media/uploads/${assetId}/part-urls`)
          .send({ partNumbers: [1] }),
        409,
        ErrorCode.UploadNotInProgress,
      );
    });
  });

  describe('auth matrix', () => {
    it('another instructor gets 404 on every route of A’s asset (no id probing)', async (ctx) => {
      skip(ctx);
      const { assetOfA, pendingOfA } = fixtures();
      expectProblem(await instructorB().get(`${V1}/media/assets/${assetOfA}`), 404);
      expectProblem(await instructorB().get(`${V1}/media/uploads/${pendingOfA}`), 404);
      expectProblem(
        await instructorB()
          .post(`${V1}/media/uploads/${pendingOfA}/part-urls`)
          .send({ partNumbers: [1] }),
        404,
      );
      expectProblem(
        await instructorB().post(`${V1}/media/uploads/${pendingOfA}/complete`).send({}),
        404,
      );
      expectProblem(await instructorB().delete(`${V1}/media/uploads/${pendingOfA}`), 404);
      // Unknown and malformed ids look the same.
      expectProblem(await instructorB().get(`${V1}/media/assets/${randomUUID()}`), 404);
      expectProblem(await instructorB().get(`${V1}/media/assets/not-a-uuid`), 404);
      // And the listing silently omits A's assets.
      const list = await instructorB().get(`${V1}/media/assets?ids=${assetOfA}`).expect(200);
      expect(list.body).toEqual({ items: [], nextCursor: null });
    });

    it('the owner lists their own assets (ids and keyset page)', async (ctx) => {
      skip(ctx);
      const { assetOfA, pendingOfA, instructorA: a } = fixtures();
      const byIds = await instructorA()
        .get(`${V1}/media/assets?ids=${pendingOfA},${assetOfA}`)
        .expect(200);
      expect(byIds.body.items.map((i: { id: string }) => i.id)).toEqual([pendingOfA, assetOfA]);

      const page1 = await instructorA().get(`${V1}/media/assets?limit=1`).expect(200);
      expect(page1.body.items).toHaveLength(1);
      expect(typeof page1.body.nextCursor).toBe('string');
      const page2 = await instructorA()
        .get(`${V1}/media/assets?limit=100&cursor=${page1.body.nextCursor as string}`)
        .expect(200);
      const ids = [...page1.body.items, ...page2.body.items].map((i: { id: string }) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(expect.arrayContaining([assetOfA, pendingOfA]));
      expect(
        [...page1.body.items, ...page2.body.items].every(
          (i: { ownerId: string }) => i.ownerId === a.userId,
        ),
      ).toBe(true);
    });

    it('an admin reads any asset and lists everyone’s, but cannot upload', async (ctx) => {
      skip(ctx);
      const { assetOfA, pendingOfA, instructorA: a } = fixtures();
      const one = await admin().get(`${V1}/media/assets/${assetOfA}`).expect(200);
      expect(AssetViewSchema.parse(one.body).ownerId).toBe(a.userId);
      await admin().get(`${V1}/media/uploads/${pendingOfA}`).expect(200);
      const list = await admin().get(`${V1}/media/assets?ids=${assetOfA}`).expect(200);
      expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([assetOfA]);
      const ofA = await admin().get(`${V1}/media/assets?ownerId=${a.userId}&limit=100`).expect(200);
      expect(ofA.body.items.length).toBeGreaterThanOrEqual(2);
      expect(ofA.body.items.every((i: { ownerId: string }) => i.ownerId === a.userId)).toBe(true);

      expectProblem(
        await admin().post(`${V1}/media/uploads`).send({
          purpose: 'COURSE_THUMBNAIL',
          filename: 'c.png',
          contentType: 'image/png',
          sizeBytes: 10,
        }),
        403,
        ErrorCode.Forbidden,
      );
      expectProblem(
        await admin()
          .post(`${V1}/media/uploads/${pendingOfA}/part-urls`)
          .send({ partNumbers: [1] }),
        403,
        ErrorCode.Forbidden,
      );
    });

    it('a student is forbidden everywhere (403), an anonymous caller is 401', async (ctx) => {
      skip(ctx);
      const { assetOfA } = fixtures();
      expectProblem(
        await student().post(`${V1}/media/uploads`).send({
          purpose: 'COURSE_THUMBNAIL',
          filename: 'c.png',
          contentType: 'image/png',
          sizeBytes: 10,
        }),
        403,
        ErrorCode.Forbidden,
      );
      expectProblem(await student().get(`${V1}/media/assets`), 403, ErrorCode.Forbidden);
      expectProblem(
        await student().get(`${V1}/media/assets/${assetOfA}`),
        403,
        ErrorCode.Forbidden,
      );
      const anonymous = await e2e.http().get(`${V1}/media/assets`).set(e2e.client('instructor'));
      expectProblem(anonymous, 401);
    });

    it('instructor tokens are confined to the instructor app (401 through another BFF)', async (ctx) => {
      skip(ctx);
      const res = await e2e
        .as('student', fixtures().tokens.a.accessToken)
        .get(`${V1}/media/assets/${fixtures().assetOfA}`);
      expectProblem(res, 401);
    });
  });
});
