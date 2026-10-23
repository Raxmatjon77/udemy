import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type BrowseCoursesQuery as BrowseCoursesRequest,
  BrowseCoursesQuerySchema,
  type CategoryTreeResponse,
  CategoryTreeResponseSchema,
  type CourseCardPage,
  CourseCardPageSchema,
  type CourseIdParams,
  CourseIdParamsSchema,
  type CourseLanding,
  CourseLandingSchema,
  type CourseSlugParams,
  CourseSlugParamsSchema,
  type LecturePlaylistParams,
  LecturePlaylistParamsSchema,
  type LectureVariantPlaylistParams,
  LectureVariantPlaylistParamsSchema,
  type PublicArticle,
  PublicArticleSchema,
  type SignedUrl,
  SignedUrlSchema,
  type ThumbnailQuery,
  ThumbnailQuerySchema,
} from '@udemy/contracts';
import type { Response } from 'express';
import { type ClientContext, CurrentClient, Public } from '../../../shared/auth';
import { PlaybackRateLimiter } from '../application/ports/playback-rate-limiter';
import { BrowseCoursesQuery } from '../application/use-cases/browse-courses.query';
import { GetCourseLandingQuery } from '../application/use-cases/get-course-landing.query';
import { GetCourseThumbnailQuery } from '../application/use-cases/get-course-thumbnail.query';
import { GetLectureArticleQuery } from '../application/use-cases/get-lecture-article.query';
import { GetLectureDownloadQuery } from '../application/use-cases/get-lecture-download.query';
import { GetLecturePlaylistQuery } from '../application/use-cases/get-lecture-playlist.query';
import { ListCategoryTreeQuery } from '../application/use-cases/list-category-tree.query';
import type { PlaybackViewer } from '../domain/playback-access';
import {
  MASTER_PLAYLIST_SHORT_CACHE,
  noStore,
  PLAYLIST_NO_STORE,
  PLAYLIST_RESPONSE_CONTENT,
  PlaybackViewerParam,
  sendPlaylist,
} from './playback-http';

const LIVE_404 =
  'course_not_found (unknown, unpublished, archived or deleted) / lecture_not_found (not in the live revision)';
const PLAYBACK_ERRORS = {
  forbidden: 'lecture_locked (not a free preview, and the viewer is not entitled)',
  conflict: 'media_not_ready',
  unprocessable: 'lecture_type_mismatch (not a VIDEO lecture)',
} as const;

/**
 * `/api/v1/catalog/...`: the public catalog (design §5, §8), for the student BFF with client
 * credentials only. Everything is read from LIVE revisions, never the working copy.
 *
 * Authentication is optional (`@Public` + JwtAuthGuard): a valid Bearer lets the owner, a
 * moderator (admin app) or, from Phase 4, an entitled student play non-preview lectures.
 * Playlists, articles and downloads are rate-limited per end-user IP, thumbnail presigns
 * separately (design §9).
 */
@ApiTags('catalog-public')
@Public()
@Controller('catalog')
export class PublicCatalogController {
  constructor(
    private readonly categoryTree: ListCategoryTreeQuery,
    private readonly browseCourses: BrowseCoursesQuery,
    private readonly courseLanding: GetCourseLandingQuery,
    private readonly courseThumbnail: GetCourseThumbnailQuery,
    private readonly playlists: GetLecturePlaylistQuery,
    private readonly articles: GetLectureArticleQuery,
    private readonly downloads: GetLectureDownloadQuery,
    private readonly rateLimiter: PlaybackRateLimiter,
  ) {}

  @Get('categories')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({ summary: 'Active category tree (groups and their leaves, ordered)' })
  @ApiOkResponse({ standardSchema: CategoryTreeResponseSchema })
  categories(): Promise<CategoryTreeResponse> {
    return this.categoryTree.execute();
  }

  @Get('courses')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    summary: 'Browse published courses (newest first)',
    description:
      'Cards come from the live revision. `category` is a slug; a group includes its leaves.',
  })
  @ApiOkResponse({ standardSchema: CourseCardPageSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiUnprocessableEntityResponse({ description: 'validation_failed (invalid cursor)' })
  courses(
    @Query({ schema: BrowseCoursesQuerySchema }) query: BrowseCoursesRequest,
  ): Promise<CourseCardPage> {
    return this.browseCourses.execute(query);
  }

  @Get('courses/by-slug/:slug')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Landing page of a published course (live revision only)' })
  @ApiOkResponse({ standardSchema: CourseLandingSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'course_not_found' })
  landing(
    @Param({ schema: CourseSlugParamsSchema }) params: CourseSlugParams,
  ): Promise<CourseLanding> {
    return this.courseLanding.execute(params.slug);
  }

  @Get('courses/:courseId/images/thumbnail')
  @ApiOperation({
    summary: 'Presigned thumbnail of the live revision (w750 / w480)',
    description: 'Embed it through the web app redirect route; the URL expires.',
  })
  @ApiOkResponse({ standardSchema: SignedUrlSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'course_not_found / not_found (variant)' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async thumbnail(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Query({ schema: ThumbnailQuerySchema }) query: ThumbnailQuery,
    @CurrentClient() client: ClientContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignedUrl> {
    await this.rateLimiter.hitImage(client.ip);
    noStore(res);
    return this.courseThumbnail.execute({
      source: { kind: 'live', courseId: params.courseId },
      variant: query.variant,
    });
  }

  // Declared before `:rendition.m3u8`, which would otherwise also match `master.m3u8`.
  @Get('courses/:courseId/lectures/:lectureId/hls/master.m3u8')
  @ApiOperation({
    summary: 'HLS master playlist of a live lecture',
    description:
      'Free previews for anyone; other lectures for the owner, moderators or entitled users.',
  })
  @ApiProduces('application/vnd.apple.mpegurl')
  @ApiOkResponse({ description: 'Master playlist', content: PLAYLIST_RESPONSE_CONTENT })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: PLAYBACK_ERRORS.forbidden })
  @ApiNotFoundResponse({ description: LIVE_404 })
  @ApiConflictResponse({ description: PLAYBACK_ERRORS.conflict })
  @ApiUnprocessableEntityResponse({ description: PLAYBACK_ERRORS.unprocessable })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async masterPlaylist(
    @Param({ schema: LecturePlaylistParamsSchema }) params: LecturePlaylistParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
    @CurrentClient() client: ClientContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    await this.rateLimiter.hitPlayback(client.ip);
    const body = await this.playlists.master({
      source: { kind: 'live', courseId: params.courseId },
      lectureId: params.lectureId,
      viewer,
    });
    return sendPlaylist(res, body, MASTER_PLAYLIST_SHORT_CACHE);
  }

  @Get('courses/:courseId/lectures/:lectureId/hls/:rendition.m3u8')
  @ApiOperation({
    summary: 'HLS variant playlist of a live lecture (segments are presigned, TTL 1 h)',
  })
  @ApiProduces('application/vnd.apple.mpegurl')
  @ApiOkResponse({ description: 'Variant playlist', content: PLAYLIST_RESPONSE_CONTENT })
  @ApiBadRequestResponse({ description: 'validation_failed (unknown rendition name)' })
  @ApiForbiddenResponse({ description: PLAYBACK_ERRORS.forbidden })
  @ApiNotFoundResponse({ description: `${LIVE_404} / not_found (rendition)` })
  @ApiConflictResponse({ description: PLAYBACK_ERRORS.conflict })
  @ApiUnprocessableEntityResponse({ description: PLAYBACK_ERRORS.unprocessable })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async variantPlaylist(
    @Param({ schema: LectureVariantPlaylistParamsSchema }) params: LectureVariantPlaylistParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
    @CurrentClient() client: ClientContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    await this.rateLimiter.hitPlayback(client.ip);
    const body = await this.playlists.variant(
      { source: { kind: 'live', courseId: params.courseId }, lectureId: params.lectureId, viewer },
      params.rendition,
    );
    return sendPlaylist(res, body, PLAYLIST_NO_STORE);
  }

  @Get('courses/:courseId/lectures/:lectureId/article')
  @ApiOperation({ summary: 'Markdown of a live ARTICLE lecture (same rules as playback)' })
  @ApiOkResponse({ standardSchema: PublicArticleSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: PLAYBACK_ERRORS.forbidden })
  @ApiNotFoundResponse({ description: LIVE_404 })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not an ARTICLE)' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async article(
    @Param({ schema: LecturePlaylistParamsSchema }) params: LecturePlaylistParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
    @CurrentClient() client: ClientContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicArticle> {
    await this.rateLimiter.hitPlayback(client.ip);
    const article = await this.articles.execute({
      source: { kind: 'live', courseId: params.courseId },
      lectureId: params.lectureId,
      viewer,
    });
    // The body IS the gated content and access can end at any moment (refund, revocation): a
    // cached copy would keep serving it, so the browser must ask every time (never a shared cache).
    res.setHeader('Cache-Control', 'private, no-store');
    return article;
  }

  @Get('courses/:courseId/lectures/:lectureId/download')
  @ApiOperation({
    summary: 'Presigned download of a live RESOURCE lecture (attachment, TTL 5 min)',
    description: 'Free previews do not apply: owner, moderators or entitled users only.',
  })
  @ApiOkResponse({ standardSchema: SignedUrlSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiForbiddenResponse({ description: 'lecture_locked' })
  @ApiNotFoundResponse({ description: LIVE_404 })
  @ApiConflictResponse({ description: PLAYBACK_ERRORS.conflict })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not a RESOURCE)' })
  @ApiTooManyRequestsResponse({ description: 'rate_limited' })
  async download(
    @Param({ schema: LecturePlaylistParamsSchema }) params: LecturePlaylistParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
    @CurrentClient() client: ClientContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignedUrl> {
    await this.rateLimiter.hitPlayback(client.ip);
    noStore(res);
    return this.downloads.execute({
      source: { kind: 'live', courseId: params.courseId },
      lectureId: params.lectureId,
      viewer,
    });
  }
}
