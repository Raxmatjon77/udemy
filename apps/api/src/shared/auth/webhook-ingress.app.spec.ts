// Must be the first import: sets process.env before app.module validates it.
import '../../testing/apply-test-env';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Injectable,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DATABASE } from '@udemy/nest-common';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { API_APP_OPTIONS, setupApp } from '../../setup-app';
import { REDIS } from '../redis';
import { VerifiesWebhookSignature, WebhookEndpoint } from './webhook-ingress.decorators';

/*
 * A provider webhook through the REAL AppModule: all four global guards in production order
 * (ClientAuthGuard -> ThrottlerGuard -> JwtAuthGuard -> PoliciesGuard), the global zod
 * validation pipe, Nest's body parsers with `API_APP_OPTIONS.rawBody`, and the route auditor
 * (boot would fail if the test route were misconfigured). This is design risk §12 (T7):
 * `Test.createTestingModule().createNestApplication(API_APP_OPTIONS)` must expose
 * `req.rawBody`, byte-identical to what the provider sent.
 *
 * The guard below is a stand-in for StripeSignatureGuard (P4-T15): HMAC-SHA256 over the raw
 * bytes, compared in constant time.
 */
const SECRET = 'whsec_test_raw_body_0123456789';
const sign = (bytes: Buffer): string => createHmac('sha256', SECRET).update(bytes).digest('hex');
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

@VerifiesWebhookSignature('stripe')
@Injectable()
class TestSignatureGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const raw = req.rawBody;
    if (!Buffer.isBuffer(raw)) throw new BadRequestException('raw body missing');
    const header = req.headers['stripe-signature'];
    const presented = Buffer.from(typeof header === 'string' ? header : '', 'utf8');
    const expected = Buffer.from(sign(raw), 'utf8');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new BadRequestException('webhook signature invalid');
    }
    return true;
  }
}

interface Echo {
  readonly rawLength: number;
  readonly rawSha256: string;
  readonly rawBase64: string;
  /** `req.body` is still parsed JSON (the raw body is kept in addition, not instead). */
  readonly parsedId: unknown;
}

@Controller('test-webhooks')
class TestWebhookController {
  @WebhookEndpoint('stripe', TestSignatureGuard)
  @Post('stripe')
  receive(@Req() req: RawBodyRequest<Request>): Echo {
    const raw = req.rawBody ?? Buffer.alloc(0);
    const body = req.body as { id?: unknown } | undefined;
    return {
      rawLength: raw.length,
      rawSha256: sha256(raw),
      rawBase64: raw.toString('base64'),
      parsedId: body?.id,
    };
  }
}

/** Odd but valid JSON: key order, whitespace, escapes and multi-byte UTF-8 all matter. */
const PAYLOAD = Buffer.from(
  '{ "type":"checkout.session.completed",\n\t"id" : "evt_123",' +
    ' "data":{"object":{"name":"Caf\\u00e9 été \u{1F600}","amount_total":1999.0}}  }\r\n',
  'utf8',
);

describe('webhook ingress through the real AppModule (raw body, guards)', () => {
  let app: NestExpressApplication;
  const fakeDatabase = { destroy: vi.fn(async () => undefined) };
  const fakeRedis = { status: 'ready', quit: vi.fn(async () => 'OK'), disconnect: vi.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestWebhookController],
      providers: [TestSignatureGuard],
    })
      .overrideProvider(DATABASE)
      .useValue(fakeDatabase)
      .overrideProvider(REDIS)
      .useValue(fakeRedis)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      logger: false,
    });
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  // superagent JSON-serializes any non-string body when the content type is JSON (a Buffer
  // would arrive as `{"type":"Buffer","data":[…]}`), so the identity serializer is what puts
  // exactly these bytes on the wire.
  const asIs = (data: unknown): string => data as string;
  const post = (body: Buffer | string, signature: string): request.Test =>
    request(app.getHttpServer())
      .post('/api/v1/test-webhooks/stripe')
      .set('content-type', 'application/json; charset=utf-8')
      .set('stripe-signature', signature)
      .serialize(asIs)
      .send(body);

  it('exposes req.rawBody byte-identical to the bytes sent, and still parses req.body', async () => {
    const res = await post(PAYLOAD, sign(PAYLOAD)).expect(200);

    const echo = res.body as Echo;
    expect(Buffer.from(echo.rawBase64, 'base64').equals(PAYLOAD)).toBe(true);
    expect(echo.rawLength).toBe(PAYLOAD.length);
    expect(echo.rawSha256).toBe(sha256(PAYLOAD));
    expect(echo.parsedId).toBe('evt_123');
  });

  it('verifies bytes, not objects: re-serialized JSON with identical content fails', async () => {
    const reserialized = JSON.stringify(JSON.parse(PAYLOAD.toString('utf8')));
    expect(reserialized).not.toBe(PAYLOAD.toString('utf8'));

    const res = await post(reserialized, sign(PAYLOAD));

    expect(res.status).toBe(400);
  });

  it('rejects a tampered byte and a missing signature', async () => {
    const tampered = Buffer.from(PAYLOAD);
    tampered[tampered.indexOf('1999')] = '2'.charCodeAt(0);

    expect((await post(tampered, sign(PAYLOAD))).status).toBe(400);
    expect((await post(PAYLOAD, '')).status).toBe(400);
  });

  it('needs no client credentials and ignores a stray Authorization header (no user)', async () => {
    const res = await post(PAYLOAD, sign(PAYLOAD))
      .set('authorization', 'Bearer not-a-token')
      .set('x-client-id', 'student-bff')
      .set('x-client-secret', 'wrong');

    expect(res.status).toBe(200);
  });

  it('keeps the default 100 kB JSON limit (413 problem above it, not a 500)', async () => {
    const big = Buffer.from(JSON.stringify({ id: 'evt_big', pad: 'x'.repeat(110 * 1024) }));

    const res = await post(big, sign(big));

    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 413, detail: 'request entity too large' });
  });
});
