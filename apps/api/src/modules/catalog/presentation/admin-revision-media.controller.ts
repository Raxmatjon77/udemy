import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  type PublicArticle,
  PublicArticleSchema,
  type RevisionIdParams,
  RevisionIdParamsSchema,
  type RevisionLectureDownloadResponse,
  RevisionLectureDownloadResponseSchema,
  type RevisionLectureParams,
  RevisionLectureParamsSchema,
  type RevisionLecturePlaylistParams,
  RevisionLecturePlaylistParamsSchema,
  type RevisionLectureVariantPlaylistParams,
  RevisionLectureVariantPlaylistParamsSchema,
  type RevisionThumbnailQuery,
  RevisionThumbnailQuerySchema,
  type RevisionThumbnailResponse,
  RevisionThumbnailResponseSchema,
} from '@udemy/contracts';
import type { Response } from 'express';
import { RequirePermissions } from '../../../shared/auth';
import { GetCourseThumbnailQuery } from '../application/use-cases/get-course-thumbnail.query';
import { GetLectureArticleQuery } from '../application/use-cases/get-lecture-article.query';
import { GetLectureDownloadQuery } from '../application/use-cases/get-lecture-download.query';
import { GetLecturePlaylistQuery } from '../application/use-cases/get-lecture-playlist.query';
import type { PlaybackViewer } from '../domain/playback-access';
import {
  MASTER_PLAYLIST_SHORT_CACHE,
  noStore,
  PLAYLIST_NO_STORE,
  PLAYLIST_RESPONSE_CONTENT,
  PlaybackViewerParam,
  sendPlaylist,
} from './playback-http';

const REVISION_404 = 'not_found (revision) / lecture_not_found (not in this revision)';

/**
 * `/api/v1/admin/course-revisions/:revisionId/...`: the media of a revision exactly as it was
 * submitted (design §8; admin app, `course:read:any`): the reviewer plays, reads and downloads
 * what will go live, independent of later working-copy edits. Every lecture is looked up in
 * THAT revision (404 otherwise).
 */
@ApiTags('catalog-admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@RequirePermissions('course:read:any')
@Controller('admin/course-revisions/:revisionId')
export class AdminRevisionMediaController {
  constructor(
    private readonly thumbnails: GetCourseThumbnailQuery,
    private readonly playlists: GetLecturePlaylistQuery,
    private readonly articles: GetLectureArticleQuery,
    private readonly downloads: GetLectureDownloadQuery,
  ) {}

  @Get('thumbnail')
  @ApiOperation({ summary: 'Presigned thumbnail of the revision (w750 / w480)' })
  @ApiOkResponse({ standardSchema: RevisionThumbnailResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found' })
  @ApiConflictResponse({ description: 'media_not_ready' })
  thumbnail(
    @Param({ schema: RevisionIdParamsSchema }) params: RevisionIdParams,
    @Query({ schema: RevisionThumbnailQuerySchema }) query: RevisionThumbnailQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevisionThumbnailResponse> {
    noStore(res);
    return this.thumbnails.execute({
      source: { kind: 'revision', revisionId: params.revisionId },
      variant: query.variant,
    });
  }

  // Declared before `:rendition.m3u8`, which would otherwise also match `master.m3u8`.
  @Get('lectures/:lectureId/hls/master.m3u8')
  @ApiOperation({ summary: 'HLS master playlist of a video lecture in the revision' })
  @ApiProduces('application/vnd.apple.mpegurl')
  @ApiOkResponse({ description: 'Master playlist', content: PLAYLIST_RESPONSE_CONTENT })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: REVISION_404 })
  @ApiConflictResponse({ description: 'media_not_ready' })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not a VIDEO lecture)' })
  async masterPlaylist(
    @Param({ schema: RevisionLecturePlaylistParamsSchema }) params: RevisionLecturePlaylistParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const body = await this.playlists.master({
      source: { kind: 'revision', revisionId: params.revisionId },
      lectureId: params.lectureId,
      viewer,
    });
    return sendPlaylist(res, body, MASTER_PLAYLIST_SHORT_CACHE);
  }

  @Get('lectures/:lectureId/hls/:rendition.m3u8')
  @ApiOperation({ summary: 'HLS variant playlist of a video lecture in the revision' })
  @ApiProduces('application/vnd.apple.mpegurl')
  @ApiOkResponse({ description: 'Variant playlist', content: PLAYLIST_RESPONSE_CONTENT })
  @ApiBadRequestResponse({ description: 'validation_failed (unknown rendition name)' })
  @ApiNotFoundResponse({ description: `${REVISION_404} / not_found (rendition)` })
  @ApiConflictResponse({ description: 'media_not_ready' })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not a VIDEO lecture)' })
  async variantPlaylist(
    @Param({ schema: RevisionLectureVariantPlaylistParamsSchema })
    params: RevisionLectureVariantPlaylistParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const body = await this.playlists.variant(
      {
        source: { kind: 'revision', revisionId: params.revisionId },
        lectureId: params.lectureId,
        viewer,
      },
      params.rendition,
    );
    return sendPlaylist(res, body, PLAYLIST_NO_STORE);
  }

  @Get('lectures/:lectureId/article')
  @ApiOperation({ summary: 'Markdown of an ARTICLE lecture in the revision' })
  @ApiOkResponse({ standardSchema: PublicArticleSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: REVISION_404 })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not an ARTICLE)' })
  article(
    @Param({ schema: RevisionLectureParamsSchema }) params: RevisionLectureParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
  ): Promise<PublicArticle> {
    return this.articles.execute({
      source: { kind: 'revision', revisionId: params.revisionId },
      lectureId: params.lectureId,
      viewer,
    });
  }

  @Get('lectures/:lectureId/download')
  @ApiOperation({ summary: 'Presigned download of a RESOURCE lecture in the revision' })
  @ApiOkResponse({ standardSchema: RevisionLectureDownloadResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: REVISION_404 })
  @ApiConflictResponse({ description: 'media_not_ready' })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not a RESOURCE)' })
  download(
    @Param({ schema: RevisionLectureParamsSchema }) params: RevisionLectureParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RevisionLectureDownloadResponse> {
    noStore(res);
    return this.downloads.execute({
      source: { kind: 'revision', revisionId: params.revisionId },
      lectureId: params.lectureId,
      viewer,
    });
  }
}
