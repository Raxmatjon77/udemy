// Must stay the first import: AppModule (imported by the harness) validates process.env.
import '../../testing/e2e/apply-e2e-app-env';
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  type NotificationApp,
  NotificationPageSchema,
  NotificationPreferencesSchema,
  REALTIME_SOCKET_PATH,
  RealtimeTicketSchema,
  UNREAD_COUNT_CAP,
  UnreadCountSchema,
} from '@udemy/contracts';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { realtimeAdapterOf } from '../../shared/realtime';
import {
  type E2eHarness,
  expectProblem,
  type HttpMethod,
  useE2eApp,
} from '../../testing/e2e/e2e-harness';
import { SECTION_8_PHASE_5_NOTIFICATIONS } from '../../testing/e2e/section-8';
import { TEST_ENV } from '../../testing/test-env';
import { SessionRevocationStore } from '../identity';
import { UnsubscribeTokenCodec } from './application/ports/unsubscribe-token.codec';
import { unsubscribeRateLimitKey } from './application/use-cases/unsubscribe.command';

/*
 * P5-T14 end to end: the real AppModule on Postgres + Redis, the Redis socket.io adapter and a
 * real socket.io client. Notification rows are inserted with SQL, as the worker's notifiers
 * would (fan-out is P5-T15).
 *
 * Covers: the §8 notification routes against Swagger and Express, the inbox (keyset with equal
 * timestamps, unreadOnly, app scoping, the 99+ cap), mark-read and read-all (idempotency, IDOR,
 * newer rows untouched, read_at set once), preferences (defaults, partial update, 422
 * preference_locked), the public unsubscribe (HMAC token, 400 forgeries, client allowlist, 429
 * per IP), the `notification.unread` push after a mark-read, and the revoked-session sweep on a
 * live socket.
 */

const V1 = '/api/v1';
const ORIGIN = TEST_ENV.REALTIME_ALLOWED_ORIGINS.split(',')[0] ?? '';
const COURSE = '01900000-0000-7000-8000-0000000e2e01';
const METHODS: readonly HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];

interface Student {
  readonly userId: string;
  readonly accessToken: string;
  readonly sessionId: string;
}

describe('notifications (e2e)', () => {
  const e2e: E2eHarness = useE2eApp();
  const sockets: ClientSocket[] = [];
  const usedIps = new Set<string>();

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  afterAll(async () => {
    if (!e2e.redis.available || usedIps.size === 0) return;
    await e2e.redis.redis.del(...[...usedIps].map(unsubscribeRateLimitKey));
  });

  async function student(): Promise<Student> {
    const user = await e2e.signup();
    await e2e.verifyEmailViaSql(user.userId);
    const auth = await e2e.login('student', user.email);
    const row = await e2e.pg.db
      .selectFrom('identity.sessions')
      .select('id')
      .where('userId', '=', user.userId)
      .orderBy('createdAt', 'desc')
      .executeTakeFirstOrThrow();
    return { userId: user.userId, accessToken: auth.accessToken, sessionId: row.id };
  }

  /** Inserts ANNOUNCEMENT rows like the fan-out would; `at` is the exact created_at. */
  async function notify(
    userId: string,
    count: number,
    options: { app?: NotificationApp; at?: string } = {},
  ): Promise<string[]> {
    const rows = Array.from({ length: count }, (_, i) => {
      const announcementId = randomUUID();
      return {
        userId,
        app: options.app ?? 'STUDENT',
        kind: options.app === 'INSTRUCTOR' ? 'MEDIA_READY' : 'ANNOUNCEMENT',
        payload:
          options.app === 'INSTRUCTOR'
            ? { assetId: announcementId, purpose: 'LECTURE_VIDEO', filename: 'intro.mp4' }
            : {
                announcementId,
                courseId: COURSE,
                courseTitle: 'E2E course',
                title: `Announcement ${i}`,
                authorName: 'Ada',
                redacted: false,
              },
        subjectType: options.app === 'INSTRUCTOR' ? 'MEDIA_ASSET' : 'ANNOUNCEMENT',
        subjectId: announcementId,
        sourceEventId: randomUUID(),
        ...(options.at === undefined ? {} : { createdAt: options.at }),
      };
    });
    const inserted = await e2e.pg.db
      .insertInto('notifications.notifications')
      .values(rows)
      .returning('id')
      .execute();
    return inserted.map((r) => r.id);
  }

  async function connect(accessToken: string): Promise<ClientSocket> {
    const res = await e2e.as('student', accessToken).post(`${V1}/realtime/tickets`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { ticket } = RealtimeTicketSchema.parse(res.body);
    const url = await e2e.realtimeUrl();
    return new Promise((resolve, reject) => {
      const socket = io(url, {
        path: REALTIME_SOCKET_PATH,
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: { ticket },
        extraHeaders: { origin: ORIGIN },
      });
      sockets.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }

  /* ------------------------------------------------------------------ routes */

  it('serves and documents exactly the §8 notification operations', async (ctx) => {
    e2e.skip(ctx);
    const op = ([path, method]: readonly [string, string]): string =>
      `${method.toUpperCase()} ${path}`;
    const ours = (path: string): boolean =>
      path.startsWith(`${V1}/me/notification`) || path.startsWith(`${V1}/notifications`);
    const expected = SECTION_8_PHASE_5_NOTIFICATIONS.map(op).sort();

    const docs = await e2e.http().get('/api/docs-json').expect(200);
    const paths = (docs.body as { paths: Record<string, Record<string, unknown>> }).paths;
    const documented = Object.entries(paths)
      .filter(([path]) => ours(path))
      .flatMap(([path, item]) =>
        Object.keys(item)
          .filter((m) => (METHODS as readonly string[]).includes(m))
          .map((method) => op([path, method])),
      )
      .sort();
    expect(documented).toEqual(expected);

    interface Layer {
      route?: { path: unknown; methods: Record<string, boolean> };
    }
    const router = (e2e.app.getHttpAdapter().getInstance() as { router?: { stack?: Layer[] } })
      .router;
    const served = (router?.stack ?? []).flatMap((layer) => {
      const route = layer.route;
      if (route === undefined || typeof route.path !== 'string') return [];
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      if (!ours(path)) return [];
      return Object.keys(route.methods)
        .filter((m) => (METHODS as readonly string[]).includes(m))
        .map((method) => op([path, method]));
    });
    expect([...new Set(served)].sort()).toEqual(expected);
  });

  /* ------------------------------------------------------------------ inbox */

  it('pages the own inbox newest first, equal timestamps by id, with unreadOnly', async (ctx) => {
    e2e.skip(ctx);
    const alice = await student();
    const at = '2026-10-24T10:00:00.123456Z';
    const sameInstant = await notify(alice.userId, 3, { at });
    const [newest] = await notify(alice.userId, 1, { at: '2026-10-24T11:00:00.000001Z' });
    await notify(alice.userId, 2, { app: 'INSTRUCTOR' }); // other app: never in the student inbox
    const http = e2e.as('student', alice.accessToken);

    const first = await http.get(`${V1}/me/notifications?limit=2`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const page1 = NotificationPageSchema.parse(first.body);
    const byIdDesc = [...sameInstant].sort().reverse();
    expect(page1.items.map((n) => n.id)).toEqual([newest, byIdDesc[0]]);

    const second = await http.get(
      `${V1}/me/notifications?limit=2&cursor=${page1.nextCursor ?? ''}`,
    );
    const page2 = NotificationPageSchema.parse(second.body);
    expect(page2.items.map((n) => n.id)).toEqual(byIdDesc.slice(1));
    expect(page2.nextCursor).toBeNull();
    expect(page2.items.every((n) => n.app === 'STUDENT' && n.category === 'ANNOUNCEMENTS')).toBe(
      true,
    );

    await http.post(`${V1}/me/notifications/${newest}/read`).expect(204);
    const unread = NotificationPageSchema.parse(
      (await http.get(`${V1}/me/notifications?unreadOnly=true`)).body,
    );
    expect(unread.items.map((n) => n.id)).not.toContain(newest);
    expect(unread.items).toHaveLength(3);

    expectProblem(
      await http.get(`${V1}/me/notifications?cursor=Zm9v`),
      422,
      ErrorCode.ValidationFailed,
    );
  });

  it('counts unread rows up to the 99+ cap', async (ctx) => {
    e2e.skip(ctx);
    const alice = await student();
    const http = e2e.as('student', alice.accessToken);
    expect(
      UnreadCountSchema.parse((await http.get(`${V1}/me/notifications/unread-count`)).body),
    ).toEqual({ count: 0, capped: false });

    await notify(alice.userId, UNREAD_COUNT_CAP + 3);
    expect((await http.get(`${V1}/me/notifications/unread-count`)).body).toEqual({
      count: UNREAD_COUNT_CAP,
      capped: true,
    });
  });

  /* ------------------------------------------------------------------ mark read */

  it('marks read once (idempotent), and read-all leaves newer rows unread', async (ctx) => {
    e2e.skip(ctx);
    const alice = await student();
    const [oldest, middle] = await notify(alice.userId, 2, { at: '2026-10-24T09:00:00Z' });
    const [newer] = await notify(alice.userId, 1, { at: '2026-10-24T12:00:00Z' });
    const http = e2e.as('student', alice.accessToken);

    await http.post(`${V1}/me/notifications/${oldest}/read`).expect(204);
    const first = await e2e.pg.db
      .selectFrom('notifications.notifications')
      .select('readAt')
      .where('id', '=', oldest ?? '')
      .executeTakeFirstOrThrow();
    await http.post(`${V1}/me/notifications/${oldest}/read`).expect(204);
    const again = await e2e.pg.db
      .selectFrom('notifications.notifications')
      .select('readAt')
      .where('id', '=', oldest ?? '')
      .executeTakeFirstOrThrow();
    expect(again.readAt).toEqual(first.readAt);

    // Both 09:00 rows share created_at, so the larger id is the later one in keyset order:
    // read-all up to it covers both, never the 12:00 row.
    const upToId = [oldest ?? '', middle ?? ''].sort().at(-1) ?? '';
    await http.post(`${V1}/me/notifications/read-all`).send({ upToId }).expect(204);
    const rows = await e2e.pg.db
      .selectFrom('notifications.notifications')
      .select(['id', 'readAt'])
      .where('userId', '=', alice.userId)
      .execute();
    expect(rows.filter((r) => r.readAt === null).map((r) => r.id)).toEqual([newer]);
    await http.post(`${V1}/me/notifications/read-all`).send({ upToId }).expect(204);

    expectProblem(
      await http.post(`${V1}/me/notifications/read-all`).send({ upToId: 'x' }),
      400,
      ErrorCode.ValidationFailed,
    );
  });

  it('IDOR: another user (or another app of the same user) gets 404 and changes nothing', async (ctx) => {
    e2e.skip(ctx);
    const alice = await student();
    const bob = await student();
    const [aliceRow] = await notify(alice.userId, 1);
    const [instructorRow] = await notify(alice.userId, 1, { app: 'INSTRUCTOR' });
    const asBob = e2e.as('student', bob.accessToken);
    const asAlice = e2e.as('student', alice.accessToken);

    expectProblem(
      await asBob.post(`${V1}/me/notifications/${aliceRow}/read`),
      404,
      ErrorCode.NotificationNotFound,
    );
    expectProblem(
      await asBob.post(`${V1}/me/notifications/read-all`).send({ upToId: aliceRow }),
      404,
      ErrorCode.NotificationNotFound,
    );
    expectProblem(
      await asAlice.post(`${V1}/me/notifications/${instructorRow}/read`),
      404,
      ErrorCode.NotificationNotFound,
    );
    expectProblem(
      await asAlice.post(`${V1}/me/notifications/${randomUUID()}/read`),
      404,
      ErrorCode.NotificationNotFound,
    );
    const unread = await e2e.pg.db
      .selectFrom('notifications.notifications')
      .select('id')
      .where('userId', '=', alice.userId)
      .where('readAt', 'is', null)
      .execute();
    expect(unread).toHaveLength(2);
    expect(
      NotificationPageSchema.parse((await asBob.get(`${V1}/me/notifications`)).body).items,
    ).toEqual([]);
  });

  it('needs a user: no Bearer is 401', async (ctx) => {
    e2e.skip(ctx);
    expectProblem(
      await e2e.http().get(`${V1}/me/notifications`).set(e2e.client('student')),
      401,
      ErrorCode.Unauthorized,
    );
  });

  /* ------------------------------------------------------------------ preferences */

  it('reads defaults, updates some pairs, and refuses locked ones (422)', async (ctx) => {
    e2e.skip(ctx);
    const alice = await student();
    const http = e2e.as('student', alice.accessToken);

    const initial = NotificationPreferencesSchema.parse(
      (await http.get(`${V1}/me/notification-preferences`)).body,
    );
    expect(initial.items).toHaveLength(12);
    expect(initial.items.every((i) => i.isDefault)).toBe(true);

    const updated = await http
      .put(`${V1}/me/notification-preferences`)
      .send({ items: [{ category: 'QA', channel: 'EMAIL', enabled: false }] });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(
      NotificationPreferencesSchema.parse(updated.body).items.filter((i) => !i.isDefault),
    ).toEqual([
      { category: 'QA', channel: 'EMAIL', enabled: false, locked: false, isDefault: false },
    ]);

    expectProblem(
      await http
        .put(`${V1}/me/notification-preferences`)
        .send({ items: [{ category: 'MODERATION', channel: 'EMAIL', enabled: false }] }),
      422,
      ErrorCode.PreferenceLocked,
    );
    expectProblem(
      await http.put(`${V1}/me/notification-preferences`).send({ items: [] }),
      400,
      ErrorCode.ValidationFailed,
    );
  });

  /* ------------------------------------------------------------------ unsubscribe */

  it('unsubscribes with a genuine token (no session), idempotently', async (ctx) => {
    e2e.skip(ctx);
    const alice = await student();
    const ip = await e2e.freshIp();
    usedIps.add(ip);
    const token = e2e.app
      .get(UnsubscribeTokenCodec, { strict: false })
      .sign({ userId: alice.userId, category: 'ANNOUNCEMENTS' });

    for (let i = 0; i < 2; i += 1) {
      const res = await e2e
        .http()
        .post(`${V1}/notifications/unsubscribe`)
        .set(e2e.client('student', { ip }))
        .send({ token });
      expect(res.status, JSON.stringify(res.body)).toBe(204);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    const rows = await e2e.pg.db
      .selectFrom('notifications.notificationPreferences')
      .select(['category', 'channel', 'enabled'])
      .where('userId', '=', alice.userId)
      .execute();
    expect(rows).toEqual([{ category: 'ANNOUNCEMENTS', channel: 'EMAIL', enabled: false }]);
  });

  it('answers 400 invalid_unsubscribe_token for forged and locked tokens', async (ctx) => {
    e2e.skip(ctx);
    const alice = await student();
    const ip = await e2e.freshIp();
    usedIps.add(ip);
    const genuine = e2e.app
      .get(UnsubscribeTokenCodec, { strict: false })
      .sign({ userId: alice.userId, category: 'QA' });
    const forged = genuine.replace('.QA.', '.REVIEWS.');

    for (const token of [forged, `v1.${alice.userId}.MODERATION.${'A'.repeat(43)}`, 'v1.x']) {
      expectProblem(
        await e2e
          .http()
          .post(`${V1}/notifications/unsubscribe`)
          .set(e2e.client('student', { ip }))
          .send({ token }),
        400,
        ErrorCode.InvalidUnsubscribeToken,
      );
    }
    const rows = await e2e.pg.db
      .selectFrom('notifications.notificationPreferences')
      .select('category')
      .where('userId', '=', alice.userId)
      .execute();
    expect(rows).toEqual([]);
  });

  it('is served to the student BFF only, and limited to 30 per hour per IP', async (ctx) => {
    e2e.skip(ctx);
    const ip = await e2e.freshIp();
    usedIps.add(ip);
    expectProblem(
      await e2e
        .http()
        .post(`${V1}/notifications/unsubscribe`)
        .set(e2e.client('instructor', { ip }))
        .send({ token: 'v1.x' }),
      403,
      ErrorCode.ClientNotAllowed,
    );

    for (let i = 0; i < 30; i += 1) {
      await e2e
        .http()
        .post(`${V1}/notifications/unsubscribe`)
        .set(e2e.client('student', { ip }))
        .send({ token: 'v1.x' })
        .expect(400);
    }
    const limited = await e2e
      .http()
      .post(`${V1}/notifications/unsubscribe`)
      .set(e2e.client('student', { ip }))
      .send({ token: 'v1.x' });
    expectProblem(limited, 429, ErrorCode.RateLimited);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  /* ------------------------------------------------------------------ realtime */

  it('pushes notification.unread to the user room after a mark-read', async (ctx) => {
    e2e.skip(ctx);
    const alice = await student();
    const [first] = await notify(alice.userId, 2);
    const socket = await connect(alice.accessToken);
    const pushed = new Promise<unknown>((resolve) => socket.once('notification.unread', resolve));

    await e2e
      .as('student', alice.accessToken)
      .post(`${V1}/me/notifications/${first}/read`)
      .expect(204);

    await expect(pushed).resolves.toEqual({ count: 1 });
  });

  it('the revocation sweep closes a socket whose session was revoked after it connected', async (ctx) => {
    e2e.skip(ctx);
    const alice = await student();
    const socket = await connect(alice.accessToken);
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));

    await e2e.app.get(SessionRevocationStore, { strict: false }).revoke(alice.sessionId);
    const adapter = realtimeAdapterOf(e2e.app);
    expect(adapter).toBeDefined();
    await expect(adapter?.revocationSweep.sweep()).resolves.toBeGreaterThanOrEqual(1);

    await expect(closed).resolves.toBe('io server disconnect');
    // The session is over: no new ticket either.
    expectProblem(
      await e2e.as('student', alice.accessToken).post(`${V1}/realtime/tickets`),
      401,
      ErrorCode.Unauthorized,
    );
  });
});
