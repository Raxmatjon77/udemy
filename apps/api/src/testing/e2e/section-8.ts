import type { HttpMethod } from './e2e-harness';

/**
 * Every operation of the design §8 tables (Phase 1 identity/access design and the Phase 2
 * catalog-media design) as an OpenAPI path + method. `endpoints.e2e.spec.ts` checks that Swagger
 * documents exactly these (plus the health probes); `phase2.e2e.spec.ts` checks the Phase 2 part
 * against Swagger AND against the routes Express really serves (so an undocumented route, e.g.
 * one with `@ApiExcludeEndpoint`, cannot hide from the list).
 */
export type Operation = readonly [path: string, method: HttpMethod];

const V1 = '/api/v1';

/** Phase 1: identity, sessions, profiles, instructor applications, admin users. */
export const SECTION_8_PHASE_1: readonly Operation[] = [
  ['/.well-known/jwks.json', 'get'],
  [`${V1}/auth/signup`, 'post'],
  [`${V1}/auth/login`, 'post'],
  [`${V1}/auth/refresh`, 'post'],
  [`${V1}/auth/logout`, 'post'],
  [`${V1}/auth/logout-all`, 'post'],
  [`${V1}/auth/sessions`, 'get'],
  [`${V1}/auth/sessions/{sessionId}`, 'delete'],
  [`${V1}/auth/email/verification-requests`, 'post'],
  [`${V1}/auth/email/verify`, 'post'],
  [`${V1}/auth/password/forgot`, 'post'],
  [`${V1}/auth/password/reset`, 'post'],
  [`${V1}/auth/password/change`, 'post'],
  [`${V1}/me`, 'get'],
  [`${V1}/me/profile`, 'get'],
  [`${V1}/me/profile`, 'patch'],
  [`${V1}/users/{userId}/profile`, 'get'],
  [`${V1}/me/instructor-applications`, 'post'],
  [`${V1}/me/instructor-applications`, 'get'],
  [`${V1}/me/instructor-applications/{id}/withdraw`, 'post'],
  [`${V1}/instructor-applications/{id}`, 'get'],
  [`${V1}/admin/instructor-applications`, 'get'],
  [`${V1}/admin/instructor-applications/{id}/approve`, 'post'],
  [`${V1}/admin/instructor-applications/{id}/reject`, 'post'],
  [`${V1}/admin/users`, 'get'],
  [`${V1}/admin/users/{userId}`, 'get'],
  [`${V1}/admin/users/{userId}/ban`, 'post'],
  [`${V1}/admin/users/{userId}/unban`, 'post'],
];

/** Phase 2: media, catalog A (builder), catalog B (lifecycle/moderation), catalog C (public). */
export const SECTION_8_PHASE_2: readonly Operation[] = [
  // Phase 2 media (catalog-media design §8); covered by modules/media/media.e2e.spec.ts.
  [`${V1}/media/uploads`, 'post'],
  [`${V1}/media/uploads/{assetId}`, 'get'],
  [`${V1}/media/uploads/{assetId}`, 'delete'],
  [`${V1}/media/uploads/{assetId}/part-urls`, 'post'],
  [`${V1}/media/uploads/{assetId}/complete`, 'post'],
  [`${V1}/media/assets`, 'get'],
  [`${V1}/media/assets/{assetId}`, 'get'],
  // Phase 2 catalog A (P2-T9); covered by modules/catalog/catalog.e2e.spec.ts.
  [`${V1}/instructor/courses`, 'get'],
  [`${V1}/instructor/courses`, 'post'],
  [`${V1}/courses/{courseId}`, 'get'],
  [`${V1}/courses/{courseId}`, 'patch'],
  [`${V1}/courses/{courseId}`, 'delete'],
  [`${V1}/courses/{courseId}/thumbnail`, 'put'],
  [`${V1}/courses/{courseId}/thumbnail`, 'delete'],
  [`${V1}/courses/{courseId}/curriculum`, 'get'],
  [`${V1}/courses/{courseId}/curriculum/order`, 'put'],
  [`${V1}/courses/{courseId}/sections`, 'post'],
  [`${V1}/courses/{courseId}/sections/{sectionId}`, 'patch'],
  [`${V1}/courses/{courseId}/sections/{sectionId}`, 'delete'],
  [`${V1}/courses/{courseId}/sections/{sectionId}/lectures`, 'post'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}`, 'patch'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}`, 'delete'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/article`, 'get'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/article`, 'put'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/media`, 'put'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/media`, 'delete'],
  [`${V1}/admin/categories`, 'get'],
  [`${V1}/admin/categories`, 'post'],
  [`${V1}/admin/categories/order`, 'put'],
  [`${V1}/admin/categories/{id}`, 'patch'],
  [`${V1}/admin/categories/{id}`, 'delete'],
  // Phase 2 catalog B (P2-T10); covered by modules/catalog/catalog-lifecycle.e2e.spec.ts.
  [`${V1}/courses/{courseId}/submit`, 'post'],
  [`${V1}/courses/{courseId}/withdraw`, 'post'],
  [`${V1}/courses/{courseId}/archive`, 'post'],
  [`${V1}/courses/{courseId}/restore`, 'post'],
  [`${V1}/courses/{courseId}/history`, 'get'],
  [`${V1}/admin/course-reviews`, 'get'],
  [`${V1}/admin/course-revisions/{revisionId}`, 'get'],
  [`${V1}/admin/courses/{courseId}/revisions/{revisionId}/approve`, 'post'],
  [`${V1}/admin/courses/{courseId}/revisions/{revisionId}/reject`, 'post'],
  [`${V1}/admin/courses`, 'get'],
  [`${V1}/admin/courses/{courseId}/takedown`, 'post'],
  [`${V1}/admin/courses/{courseId}/restore`, 'post'],
  // Phase 2 catalog C (P2-T11); covered by modules/catalog/catalog-public.e2e.spec.ts.
  [`${V1}/catalog/categories`, 'get'],
  [`${V1}/catalog/courses`, 'get'],
  [`${V1}/catalog/courses/by-slug/{slug}`, 'get'],
  [`${V1}/catalog/courses/{courseId}/images/thumbnail`, 'get'],
  [`${V1}/catalog/courses/{courseId}/lectures/{lectureId}/hls/master.m3u8`, 'get'],
  [`${V1}/catalog/courses/{courseId}/lectures/{lectureId}/hls/{rendition}.m3u8`, 'get'],
  [`${V1}/catalog/courses/{courseId}/lectures/{lectureId}/article`, 'get'],
  [`${V1}/catalog/courses/{courseId}/lectures/{lectureId}/download`, 'get'],
  [`${V1}/courses/{courseId}/thumbnail`, 'get'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/preview/hls/master.m3u8`, 'get'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/preview/hls/{rendition}.m3u8`, 'get'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/download`, 'get'],
  [`${V1}/admin/course-revisions/{revisionId}/thumbnail`, 'get'],
  [`${V1}/admin/course-revisions/{revisionId}/lectures/{lectureId}/hls/master.m3u8`, 'get'],
  [`${V1}/admin/course-revisions/{revisionId}/lectures/{lectureId}/hls/{rendition}.m3u8`, 'get'],
  [`${V1}/admin/course-revisions/{revisionId}/lectures/{lectureId}/article`, 'get'],
  [`${V1}/admin/course-revisions/{revisionId}/lectures/{lectureId}/download`, 'get'],
];

/** Phase 4 commerce A (P4-T13); covered by modules/commerce/commerce.e2e.spec.ts. */
export const SECTION_8_PHASE_4_COMMERCE_A: readonly Operation[] = [
  [`${V1}/commerce/prices`, 'get'],
  [`${V1}/me/cart`, 'get'],
  [`${V1}/me/cart/items/{courseId}`, 'put'],
  [`${V1}/me/cart/items/{courseId}`, 'delete'],
  [`${V1}/me/cart/merge`, 'post'],
  [`${V1}/me/cart/coupon`, 'put'],
  [`${V1}/me/cart/coupon`, 'delete'],
  [`${V1}/me/purchase-states`, 'get'],
  [`${V1}/courses/{courseId}/pricing`, 'get'],
  [`${V1}/courses/{courseId}/pricing`, 'put'],
  [`${V1}/courses/{courseId}/coupons`, 'get'],
  [`${V1}/courses/{courseId}/coupons`, 'post'],
  [`${V1}/courses/{courseId}/coupons/{couponId}/deactivate`, 'post'],
  [`${V1}/admin/coupons`, 'get'],
  [`${V1}/admin/coupons`, 'post'],
  [`${V1}/admin/coupons/{couponId}/deactivate`, 'post'],
];

/** Phase 4 enrollment (P4-T12); covered by modules/enrollment/enrollment.e2e.spec.ts. */
export const SECTION_8_PHASE_4_ENROLLMENT: readonly Operation[] = [
  [`${V1}/me/free-enrollments`, 'post'],
  [`${V1}/me/enrollments`, 'get'],
  [`${V1}/admin/users/{userId}/enrollments`, 'get'],
  [`${V1}/admin/enrollments`, 'post'],
  [`${V1}/admin/enrollments/{enrollmentId}/revoke`, 'post'],
];

/**
 * Phase 4 commerce B (P4-T15): checkout, the buyer's orders, and the Stripe webhook; covered
 * by modules/commerce/commerce-b.e2e.spec.ts.
 */
export const SECTION_8_PHASE_4_COMMERCE_B: readonly Operation[] = [
  [`${V1}/me/checkout`, 'post'],
  [`${V1}/me/orders`, 'get'],
  [`${V1}/me/orders/{orderId}`, 'get'],
  [`${V1}/me/orders/{orderId}/receipt`, 'get'],
  [`${V1}/me/orders/{orderId}/cancel`, 'post'],
  [`${V1}/webhooks/stripe`, 'post'],
];

/**
 * Phase 4 commerce C (P4-T16): refund requests, admin orders and refunds, instructor sales;
 * covered by modules/commerce/commerce-c.e2e.spec.ts.
 */
export const SECTION_8_PHASE_4_COMMERCE_C: readonly Operation[] = [
  [`${V1}/me/orders/{orderId}/refunds`, 'post'],
  [`${V1}/instructor/sales/summary`, 'get'],
  [`${V1}/instructor/sales`, 'get'],
  [`${V1}/admin/orders`, 'get'],
  [`${V1}/admin/orders/{orderId}`, 'get'],
  [`${V1}/admin/orders/{orderId}/refunds`, 'post'],
  [`${V1}/admin/orders/{orderId}/accept-payment`, 'post'],
  [`${V1}/admin/refunds`, 'get'],
  [`${V1}/admin/refunds/{refundId}/approve`, 'post'],
  [`${V1}/admin/refunds/{refundId}/reject`, 'post'],
  [`${V1}/admin/refunds/{refundId}/retry`, 'post'],
];

/**
 * Phase 5 realtime plumbing (P5-T5): the WS ticket route of the learning experience design §8
 * "Notifications" (every BFF); covered by realtime.e2e.spec.ts. The socket.io
 * ingress itself (`/realtime/socket.io`) is not an HTTP operation and is not listed.
 */
export const SECTION_8_PHASE_5_REALTIME: readonly Operation[] = [
  [`${V1}/realtime/tickets`, 'post'],
];

/**
 * Phase 5 catalog (P5-T6): QUIZ authoring on the working copy (instructor BFF, `Pol course:read`
 * / `course:update`) and the admin revision quiz (`course:read:any`) of the learning experience
 * design §8 "Instructor" / "Admin"; covered by modules/catalog/catalog-quiz.e2e.spec.ts.
 */
export const SECTION_8_PHASE_5_CATALOG_QUIZ: readonly Operation[] = [
  [`${V1}/courses/{courseId}/lectures/{lectureId}/quiz`, 'get'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/quiz`, 'put'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/quiz/questions`, 'post'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/quiz/questions/{questionId}`, 'patch'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/quiz/questions/{questionId}`, 'delete'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/quiz/questions/{questionId}/options`, 'put'],
  [`${V1}/courses/{courseId}/lectures/{lectureId}/quiz/order`, 'put'],
  [`${V1}/admin/course-revisions/{revisionId}/lectures/{lectureId}/quiz`, 'get'],
];

/**
 * Phase 5 notifications (P5-T14): the inbox, preferences and the public one-click unsubscribe
 * of the learning experience design §8 "Notifications" / "Public"; covered by
 * modules/notifications/notifications.e2e.spec.ts.
 */
export const SECTION_8_PHASE_5_NOTIFICATIONS: readonly Operation[] = [
  [`${V1}/me/notifications`, 'get'],
  [`${V1}/me/notifications/unread-count`, 'get'],
  [`${V1}/me/notifications/{notificationId}/read`, 'post'],
  [`${V1}/me/notifications/read-all`, 'post'],
  [`${V1}/me/notification-preferences`, 'get'],
  [`${V1}/me/notification-preferences`, 'put'],
  [`${V1}/notifications/unsubscribe`, 'post'],
];

/**
 * Phase 5 engagement A (P5-T12): public ratings and reviews, the caller's review, the instructor
 * reviews and replies, the wishlist, and reports on reviews and replies; covered by
 * modules/engagement/engagement.e2e.spec.ts. Q&A, announcements, Q&A reports and admin
 * moderation are P5-T13.
 */
export const SECTION_8_PHASE_5_ENGAGEMENT_A: readonly Operation[] = [
  [`${V1}/engagement/ratings`, 'get'],
  [`${V1}/engagement/courses/{courseId}/reviews`, 'get'],
  [`${V1}/me/courses/{courseId}/review`, 'get'],
  [`${V1}/me/courses/{courseId}/review`, 'put'],
  [`${V1}/me/courses/{courseId}/review`, 'delete'],
  [`${V1}/courses/{courseId}/reviews`, 'get'],
  [`${V1}/courses/{courseId}/reviews/{reviewId}/reply`, 'put'],
  [`${V1}/courses/{courseId}/reviews/{reviewId}/reply`, 'delete'],
  [`${V1}/me/wishlist`, 'get'],
  [`${V1}/me/wishlist/states`, 'get'],
  [`${V1}/me/wishlist/{courseId}`, 'put'],
  [`${V1}/me/wishlist/{courseId}`, 'delete'],
  [`${V1}/engagement/reviews/{subjectId}/reports`, 'post'],
  [`${V1}/engagement/review-replies/{subjectId}/reports`, 'post'],
];

export const SECTION_8: readonly Operation[] = [
  ...SECTION_8_PHASE_1,
  ...SECTION_8_PHASE_2,
  ...SECTION_8_PHASE_4_COMMERCE_A,
  ...SECTION_8_PHASE_4_ENROLLMENT,
  ...SECTION_8_PHASE_4_COMMERCE_B,
  ...SECTION_8_PHASE_4_COMMERCE_C,
  ...SECTION_8_PHASE_5_REALTIME,
  ...SECTION_8_PHASE_5_CATALOG_QUIZ,
  ...SECTION_8_PHASE_5_NOTIFICATIONS,
  ...SECTION_8_PHASE_5_ENGAGEMENT_A,
];

/** Every Phase 4 operation (P4-T17: phase4.e2e.spec.ts checks it against Swagger and Express). */
export const SECTION_8_PHASE_4: readonly Operation[] = [
  ...SECTION_8_PHASE_4_COMMERCE_A,
  ...SECTION_8_PHASE_4_ENROLLMENT,
  ...SECTION_8_PHASE_4_COMMERCE_B,
  ...SECTION_8_PHASE_4_COMMERCE_C,
];
