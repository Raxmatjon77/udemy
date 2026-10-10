import { describe, expect, it } from 'vitest';
import * as contracts from '../index';

/**
 * @nestjs/swagger 12 renders request bodies/queries with `~standard.jsonSchema.input` and
 * responses with `.output`, targeting OpenAPI 3.0. A schema that throws here (e.g. one using
 * `.transform()`) would break the docs, so every exported schema must convert both ways.
 */
interface JsonSchemaCapable {
  '~standard': {
    jsonSchema: Record<'input' | 'output', (options: { target: string }) => unknown>;
  };
}

function isJsonSchemaCapable(value: unknown): value is JsonSchemaCapable {
  return typeof value === 'object' && value !== null && '~standard' in value;
}

const schemas = Object.entries(contracts).flatMap(([name, value]) =>
  name.endsWith('Schema') && isJsonSchemaCapable(value) ? [[name, value] as const] : [],
);

describe('JSON Schema generation (Swagger)', () => {
  it('finds the exported schemas', () => {
    expect(schemas.length).toBeGreaterThan(150);
  });

  it('covers the Phase 2 catalog & media schemas', () => {
    const names = new Set(schemas.map(([name]) => name));
    for (const name of [
      // public catalog + playback
      'CategoryTreeResponseSchema',
      'BrowseCoursesQuerySchema',
      'CourseCardPageSchema',
      'CourseLandingSchema',
      'ThumbnailQuerySchema',
      'LectureVariantPlaylistParamsSchema',
      'RevisionLectureVariantPlaylistParamsSchema',
      'PublicArticleSchema',
      // instructor builder
      'MyCoursesQuerySchema',
      'CreateCourseRequestSchema',
      'UpdateCourseRequestSchema',
      'CourseDetailSchema',
      'CurriculumSchema',
      'ReorderCurriculumRequestSchema',
      'SubmitCourseRequestSchema',
      'CourseNotReadyProblemSchema',
      'CourseHistoryResponseSchema',
      // media
      'InitiateUploadRequestSchema',
      'PresignPartsRequestSchema',
      'AssetViewSchema',
      'AssetsQuerySchema',
      'UploadIncompleteProblemSchema',
      // admin
      'ReviewQueuePageSchema',
      'RevisionReviewSchema',
      'RejectRevisionRequestSchema',
      'AdminCoursesQuerySchema',
      'AdminCategoryTreeResponseSchema',
      'ReorderCategoriesRequestSchema',
      // Phase 2 follow-ups (design §14)
      'ListAssetsQuerySchema',
      'AssetPageSchema',
      'MarkdownNotAllowedProblemSchema',
      'MarkdownIssueSchema',
      'RevisionDiffSchema',
      'RevisionFieldChangeSchema',
      'RevisionCategorySchema',
      'AdminCourseRowSchema',
      'CourseCardSchema',
      'CourseThumbnailQuerySchema',
      'CourseThumbnailResponseSchema',
      'LectureDownloadResponseSchema',
      'RevisionThumbnailQuerySchema',
      'RevisionThumbnailResponseSchema',
      'RevisionLectureDownloadResponseSchema',
      // Phase 4: money
      'MoneyAmountSchema',
      'CurrencySchema',
      'MoneySchema',
      'PriceTierSchema',
      // Phase 4: pricing
      'CoursePricingSchema',
      'SetCoursePriceRequestSchema',
      'PublicPricesQuerySchema',
      'PublicPricesResponseSchema',
      // Phase 4: cart, coupons, purchase states
      'CartQuoteSchema',
      'MergeGuestCartRequestSchema',
      'MergeGuestCartResponseSchema',
      'ApplyCouponRequestSchema',
      'PurchaseStatesQuerySchema',
      'PurchaseStatesResponseSchema',
      'CreateCourseCouponRequestSchema',
      'CreatePlatformCouponRequestSchema',
      'CouponPageSchema',
      // Phase 4: checkout, orders, refunds
      'CheckoutHeadersSchema',
      'CheckoutRequestSchema',
      'CheckoutResponseSchema',
      'CheckoutInProgressProblemSchema',
      'PriceChangedProblemSchema',
      'CartChangedProblemSchema',
      'OrderSummaryPageSchema',
      'OrderDetailSchema',
      'ReceiptSchema',
      'RequestRefundRequestSchema',
      'RefundSchema',
      // Phase 4: enrollment
      'FreeEnrollmentRequestSchema',
      'EnrollmentSchema',
      'MyLearningQuerySchema',
      'LearningCardPageSchema',
      'AdminUserEnrollmentsSchema',
      'AdminGrantEnrollmentRequestSchema',
      'AdminRevokeEnrollmentRequestSchema',
      // Phase 4: admin and instructor
      'AdminOrdersQuerySchema',
      'AdminOrderPageSchema',
      'AdminOrderDetailSchema',
      'AdminRefundOrderLinesRequestSchema',
      'AdminRefundOrderLinesResponseSchema',
      'AcceptPaymentRequestSchema',
      'AdminRefundsQuerySchema',
      'AdminRefundQueuePageSchema',
      'ApproveRefundRequestSchema',
      'RejectRefundRequestSchema',
      'SalesSummaryQuerySchema',
      'SalesSummarySchema',
      'RecentSalesQuerySchema',
      'RecentSalePageSchema',
      // Phase 4: webhook
      'StripeWebhookHeadersSchema',
      'WebhookAckSchema',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it.each(schemas)('%s converts in input and output mode', (_name, schema) => {
    const { jsonSchema } = schema['~standard'];
    expect(() => jsonSchema.input({ target: 'openapi-3.0' })).not.toThrow();
    expect(() => jsonSchema.output({ target: 'openapi-3.0' })).not.toThrow();
  });
});
