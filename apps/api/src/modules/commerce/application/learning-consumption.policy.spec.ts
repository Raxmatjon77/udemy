import { randomUUID } from 'node:crypto';
import {
  AdminRefundQueueItemSchema,
  CourseConsumptionSchema,
  OrderLineSchema,
  RefundReviewReasonSchema,
} from '@udemy/contracts';
import type { DB, Executor, Transaction } from '@udemy/db';
import { describe, expect, it, vi } from 'vitest';
import { CommerceSettings } from './commerce-settings';
import {
  consumptionKey,
  consumptionObjection,
  CourseConsumptionViews,
  LearningConsumptionPolicy,
  toCourseConsumption,
} from './learning-consumption.policy';
import type { CartRepository } from './ports/cart.repository';
import type { CommerceClock } from './ports/commerce-clock';
import type { CommerceRateLimiter } from './ports/commerce-rate-limiter';
import type { CommerceConsumption, CommerceLearning } from './ports/context-gateways';
import type { OrderDetailRecord, OrderRepository } from './ports/order.repository';
import type { RefundDispatchTrigger } from './ports/provider-refund-events';
import type { NewRefund, RefundRecord, RefundRepository } from './ports/refund.repository';
import type { TransactionRunner } from './ports/transaction-runner';
import type { RefundLifecycle } from './refund-lifecycle.service';
import { toQueueItem } from './refund-views';
import { RequestRefundCommand } from './use-cases/request-refund.command';

const NOTHING: CommerceConsumption = {
  videoSecondsWatched: 0,
  videoSecondsTotal: 0,
  completedLectures: 0,
  totalLectures: 0,
  courseCompletedAt: null,
  certificateStatus: null,
};

function figures(overrides: Partial<CommerceConsumption> = {}): CommerceConsumption {
  return { ...NOTHING, videoSecondsTotal: 1000, totalLectures: 10, ...overrides };
}

function learningReturning(c: CommerceConsumption) {
  const getConsumption = vi.fn(
    (_userId: string, _courseId: string, _ex?: Executor): Promise<CommerceConsumption> =>
      Promise.resolve(c),
  );
  return { getConsumption, port: { getConsumption } as CommerceLearning };
}

describe('consumptionObjection (P5-D6: certificate, then video, then lectures; strict >)', () => {
  it('no objection at or below the threshold, nor for an empty course', () => {
    expect(consumptionObjection(NOTHING, 30)).toBeNull();
    expect(consumptionObjection(figures({ videoSecondsWatched: 300 }), 30)).toBeNull();
    expect(consumptionObjection(figures({ completedLectures: 3 }), 30)).toBeNull();
    expect(consumptionObjection(figures({ certificateStatus: 'REVOKED' }), 30)).toBeNull();
  });

  it('objects above it, in order, with the floored percent', () => {
    expect(consumptionObjection(figures({ videoSecondsWatched: 301 }), 30)).toBe(
      'consumed_video_30',
    );
    expect(consumptionObjection(figures({ completedLectures: 4 }), 30)).toBe(
      'consumed_lectures_40',
    );
    expect(
      consumptionObjection(figures({ videoSecondsWatched: 500, completedLectures: 9 }), 30),
    ).toBe('consumed_video_50');
    expect(
      consumptionObjection(
        figures({ certificateStatus: 'ACTIVE', videoSecondsWatched: 1000, completedLectures: 10 }),
        30,
      ),
    ).toBe('certificate_issued');
  });

  it('a lecture-only course (no video) is judged on lectures alone', () => {
    const articles = { ...NOTHING, totalLectures: 3, completedLectures: 1 };
    expect(consumptionObjection(articles, 30)).toBe('consumed_lectures_33');
  });

  it('the threshold is the configured percent (0 = any consumption)', () => {
    expect(consumptionObjection(figures({ completedLectures: 1 }), 0)).toBe('consumed_lectures_10');
    expect(consumptionObjection(figures({ completedLectures: 10 }), 100)).toBeNull();
  });

  it('clamps figures above their totals, so reasons stay valid contract values', () => {
    const reason = consumptionObjection(figures({ videoSecondsWatched: 5000 }), 30);
    expect(reason).toBe('consumed_video_100');
    expect(RefundReviewReasonSchema.safeParse(reason).success).toBe(true);
  });
});

describe('toCourseConsumption (contracts CourseConsumption)', () => {
  it('derives integer percentages and the objection', () => {
    const completedAt = new Date('2026-10-20T10:00:00.000Z');
    const view = toCourseConsumption(
      figures({
        videoSecondsWatched: 290,
        completedLectures: 10,
        courseCompletedAt: completedAt,
        certificateStatus: 'ACTIVE',
      }),
      30,
    );
    expect(CourseConsumptionSchema.parse(view)).toEqual({
      videoSecondsWatched: 290,
      videoSecondsTotal: 1000,
      videoPct: 29,
      completedLectures: 10,
      totalLectures: 10,
      lecturesPct: 100,
      courseCompletedAt: '2026-10-20T10:00:00.000Z',
      certificateStatus: 'ACTIVE',
      reviewReason: 'certificate_issued',
    });
  });

  it('29 of 100 is 29% (integer arithmetic, no float flooring to 28)', () => {
    const view = toCourseConsumption({ ...NOTHING, completedLectures: 29, totalLectures: 100 }, 30);
    expect(view.lecturesPct).toBe(29);
    expect(view.reviewReason).toBeNull();
  });

  it('an empty course is 0% everywhere', () => {
    expect(toCourseConsumption(NOTHING, 30)).toMatchObject({
      videoPct: 0,
      lecturesPct: 0,
      reviewReason: null,
    });
  });
});

describe('LearningConsumptionPolicy', () => {
  it("reads learning on the caller's executor and applies COMMERCE_REFUND_REVIEW_CONSUMED_PCT", async () => {
    const learning = learningReturning(figures({ completedLectures: 4 }));
    const ex = {} as Executor;
    const input = { userId: randomUUID(), courseId: randomUUID(), orderLineId: randomUUID() };

    const strict = new LearningConsumptionPolicy(learning.port, CommerceSettings.defaults());
    await expect(strict.objection(input, ex)).resolves.toBe('consumed_lectures_40');
    expect(learning.getConsumption).toHaveBeenCalledWith(input.userId, input.courseId, ex);

    const lenient = new LearningConsumptionPolicy(
      learning.port,
      CommerceSettings.defaults({ refundReviewConsumedPct: 50 }),
    );
    await expect(lenient.objection(input, ex)).resolves.toBeNull();
  });
});

describe('CourseConsumptionViews', () => {
  it('reads each (user, course) once, sequentially, keyed by consumptionKey', async () => {
    const learning = learningReturning(figures({ videoSecondsWatched: 400 }));
    const views = new CourseConsumptionViews(learning.port, CommerceSettings.defaults());
    const [u1, u2, c1, c2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const map = await views.ofMany([
      { userId: u1, courseId: c1 },
      { userId: u1, courseId: c1 },
      { userId: u1, courseId: c2 },
      { userId: u2, courseId: c1 },
    ]);
    expect(learning.getConsumption).toHaveBeenCalledTimes(3);
    expect(map.size).toBe(3);
    expect(map.get(consumptionKey(u1, c2))?.reviewReason).toBe('consumed_video_40');
  });
});

/* ------------------------------------------------------------------------------------------ */

const NOW = new Date('2026-10-20T12:00:00.000Z');

function refundRecord(input: NewRefund, courseId: string): RefundRecord {
  return {
    id: randomUUID(),
    orderId: input.orderId,
    orderNumber: 1042,
    orderLineId: input.orderLineId,
    userId: input.userId,
    courseId,
    courseTitle: 'Complete TypeScript',
    instructorId: randomUUID(),
    amount: input.amount,
    currency: 'USD',
    status: input.status,
    initiatedBy: input.initiatedBy,
    reasonCode: input.reasonCode,
    comment: input.comment,
    attempt: 1,
    providerRefundId: null,
    failureCode: null,
    requestedBy: input.actorId,
    rejectionReason: null,
    reviewReason: input.initiatedBy === 'STUDENT' ? input.reason : null,
    createdAt: NOW,
    approvedAt: input.status === 'APPROVED' ? NOW : null,
    succeededAt: null,
  };
}

function requestHarness(options: { consumption: CommerceConsumption; recentRefunds?: number }) {
  const userId = randomUUID();
  const courseId = randomUUID();
  const lineId = randomUUID();
  const orderId = randomUUID();
  const trx = {} as Transaction<DB>;
  const steps: string[] = [];
  const order: OrderDetailRecord = {
    orderId,
    orderNumber: 1042,
    userId,
    status: 'PAID',
    currency: 'USD',
    totalAmount: '19.99',
    placedAt: NOW,
    paidAt: new Date(NOW.getTime() - 86_400_000),
    closedAt: null,
    payment: { status: 'SUCCEEDED', checkoutUrl: null },
    refundedAmount: '0.00',
    lines: [
      {
        id: lineId,
        lineNo: 1,
        courseId,
        courseTitle: 'Complete TypeScript',
        instructorId: randomUUID(),
        listAmount: '19.99',
        discountAmount: '0.00',
        finalAmount: '19.99',
        couponCode: null,
        latestRefund: null,
      },
    ],
  };
  const inserted: NewRefund[] = [];
  const orders = {
    findOwner: vi.fn(async () => userId),
    lockOrder: vi.fn(async () => {
      steps.push('lock order');
      return {};
    }),
    findDetail: vi.fn(async () => order),
  };
  const carts = {
    lockCart: vi.fn(async () => {
      steps.push('lock cart');
      return { couponCode: null };
    }),
  };
  const refunds = {
    countRecentStudentRefunds: vi.fn(async () => options.recentRefunds ?? 0),
    insert: vi.fn(async (_trx: Transaction<DB>, input: NewRefund) => {
      steps.push('insert');
      inserted.push(input);
      return refundRecord(input, courseId);
    }),
  };
  const lifecycle = {
    approved: vi.fn(async () => true),
    requested: vi.fn(async () => undefined),
  };
  const learning = {
    getConsumption: vi.fn(async (_u: string, _c: string, ex?: Executor) => {
      steps.push(ex === trx ? 'consumption (in tx)' : 'consumption (outside tx)');
      return options.consumption;
    }),
  };
  const dispatch = { kick: vi.fn() };
  const tx: TransactionRunner = { run: (work) => work(trx) };
  const clock: CommerceClock = { now: async () => NOW };
  const command = new RequestRefundCommand(
    tx,
    carts as unknown as CartRepository,
    orders as unknown as OrderRepository,
    refunds as unknown as RefundRepository,
    lifecycle as unknown as RefundLifecycle,
    new LearningConsumptionPolicy(learning as CommerceLearning, CommerceSettings.defaults()),
    { hitRefundRequest: vi.fn(async () => undefined) } as unknown as CommerceRateLimiter,
    clock,
    CommerceSettings.defaults(),
    dispatch as unknown as RefundDispatchTrigger,
  );
  const input = {
    userId,
    orderId,
    orderLineId: lineId,
    reasonCode: 'NOT_AS_EXPECTED' as const,
  };
  return { command, input, inserted, lifecycle, dispatch, steps, learning, courseId };
}

describe('RequestRefundCommand with the consumption rule (D11 + Phase 5 D8)', () => {
  it('little consumption and few refunds: APPROVED at once, no recorded reason, kicked', async () => {
    const h = requestHarness({ consumption: figures({ videoSecondsWatched: 100 }) });
    const refund = await h.command.execute(h.input);
    expect(refund.status).toBe('APPROVED');
    expect(h.inserted[0]).toMatchObject({ status: 'APPROVED', reason: null });
    expect(h.lifecycle.approved).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.requested).not.toHaveBeenCalled();
    expect(h.dispatch.kick).toHaveBeenCalledWith([refund.id]);
    // evaluated inside the refund transaction, after the cart and order locks
    expect(h.steps).toEqual(['lock cart', 'lock order', 'consumption (in tx)', 'insert']);
  });

  it('> 30% video watched: REQUESTED (no revocation, no kick), the reason on the first transition', async () => {
    const h = requestHarness({ consumption: figures({ videoSecondsWatched: 450 }) });
    const refund = await h.command.execute(h.input);
    expect(refund.status).toBe('REQUESTED');
    expect(h.inserted[0]).toMatchObject({
      status: 'REQUESTED',
      initiatedBy: 'STUDENT',
      reason: 'consumed_video_45',
    });
    expect(h.lifecycle.requested).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.approved).not.toHaveBeenCalled();
    expect(h.dispatch.kick).not.toHaveBeenCalled();
    expect(h.learning.getConsumption).toHaveBeenCalledWith(
      h.input.userId,
      h.courseId,
      expect.anything(),
    );
  });

  it('an ACTIVE certificate: REQUESTED with certificate_issued', async () => {
    const h = requestHarness({ consumption: figures({ certificateStatus: 'ACTIVE' }) });
    expect((await h.command.execute(h.input)).status).toBe('REQUESTED');
    expect(h.inserted[0]?.reason).toBe('certificate_issued');
  });

  it('the Phase 4 abuse rule alone still sends it to review, with no consumption reason', async () => {
    const h = requestHarness({ consumption: NOTHING, recentRefunds: 3 });
    expect((await h.command.execute(h.input)).status).toBe('REQUESTED');
    expect(h.inserted[0]?.reason).toBeNull();
  });
});

describe('refund views (Phase 5 additive fields)', () => {
  it('queue items carry the recorded reviewReason and the live consumption', () => {
    const consumption = toCourseConsumption(figures({ completedLectures: 5 }), 30);
    const record = refundRecord(
      {
        orderId: randomUUID(),
        orderLineId: randomUUID(),
        userId: randomUUID(),
        amount: '19.99',
        status: 'REQUESTED',
        initiatedBy: 'STUDENT',
        reasonCode: 'QUALITY',
        comment: null,
        actorId: randomUUID(),
        reason: 'consumed_lectures_41',
      },
      randomUUID(),
    );
    const item = AdminRefundQueueItemSchema.parse(toQueueItem(record, 0, new Map(), consumption));
    expect(item.reviewReason).toBe('consumed_lectures_41');
    expect(item.consumption).toEqual(consumption);
  });

  it('an order line accepts a consumption or null', () => {
    const consumption = toCourseConsumption(NOTHING, 30);
    const shape = OrderLineSchema.shape.consumption;
    expect(shape.safeParse(consumption).success).toBe(true);
    expect(shape.safeParse(null).success).toBe(true);
  });
});
