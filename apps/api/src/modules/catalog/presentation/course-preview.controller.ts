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
  type CourseIdParams,
  CourseIdParamsSchema,
  type CourseThumbnailQuery,
  CourseThumbnailQuerySchema,
  type CourseThumbnailResponse,
  CourseThumbnailResponseSchema,
  type LectureDownloadResponse,
  LectureDownloadResponseSchema,
  type LectureParams,
  LectureParamsSchema,
  type LecturePlaylistParams,
  LecturePlaylistParamsSchema,
  type LectureVariantPlaylistParams,
  LectureVariantPlaylistParamsSchema,
} from '@udemy/contracts';
import type { Response } from 'express';
import { CheckPolicy } from '../../../shared/auth';
import { GetCourseThumbnailQuery } from '../application/use-cases/get-course-thumbnail.query';
import { GetLectureDownloadQuery } from '../application/use-cases/get-lecture-download.query';
import { GetLecturePlaylistQuery } from '../application/use-cases/get-lecture-playlist.query';
import type { PlaybackViewer } from '../domain/playback-access';
import { courseIdOf } from './catalog-http';
import {
  noStore,
  PLAYLIST_NO_STORE,
  PLAYLIST_RESPONSE_CONTENT,
  PlaybackViewerParam,
  sendPlaylist,
} from './playback-http';

const NESTED_404 = "not_found (another instructor's course) / course_not_found / lecture_not_found";

/**
 * `/api/v1/courses/:courseId/...`: media of the WORKING COPY for the builder (design §8): the
 * owner's preview player, the current thumbnail and resource downloads, before anything is
 * submitted. The course policy answers 404 for another instructor's course; admins
 * (`course:read:any`) may read too. Lectures are loaded scoped by the course (Q7).
 */
@ApiTags('catalog')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'unauthorized / token_expired' })
@ApiForbiddenResponse({ description: 'forbidden' })
@Controller('courses/:courseId')
export class CoursePreviewController {
  constructor(
    private readonly thumbnails: GetCourseThumbnailQuery,
    private readonly playlists: GetLecturePlaylistQuery,
    private readonly downloads: GetLectureDownloadQuery,
  ) {}

  @Get('thumbnail')
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({
    summary: 'Presigned working-copy thumbnail (w750 / w480)',
    description: 'While it is still processing: 409 media_not_ready (show the asset status).',
  })
  @ApiOkResponse({ standardSchema: CourseThumbnailResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: 'not_found / course_not_found (also: no thumbnail)' })
  @ApiConflictResponse({ description: 'media_not_ready' })
  thumbnail(
    @Param({ schema: CourseIdParamsSchema }) params: CourseIdParams,
    @Query({ schema: CourseThumbnailQuerySchema }) query: CourseThumbnailQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CourseThumbnailResponse> {
    noStore(res);
    return this.thumbnails.execute({
      source: { kind: 'working', courseId: params.courseId },
      variant: query.variant,
    });
  }

  // Declared before `:rendition.m3u8`, which would otherwise also match `master.m3u8`.
  @Get('lectures/:lectureId/preview/hls/master.m3u8')
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({ summary: 'HLS master playlist of a working-copy video lecture' })
  @ApiProduces('application/vnd.apple.mpegurl')
  @ApiOkResponse({ description: 'Master playlist', content: PLAYLIST_RESPONSE_CONTENT })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: NESTED_404 })
  @ApiConflictResponse({ description: 'media_not_ready (no video, or still processing)' })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not a VIDEO lecture)' })
  async masterPlaylist(
    @Param({ schema: LecturePlaylistParamsSchema }) params: LecturePlaylistParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const body = await this.playlists.master({
      source: { kind: 'working', courseId: params.courseId },
      lectureId: params.lectureId,
      viewer,
    });
    return sendPlaylist(res, body, PLAYLIST_NO_STORE);
  }

  @Get('lectures/:lectureId/preview/hls/:rendition.m3u8')
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({ summary: 'HLS variant playlist of a working-copy video lecture' })
  @ApiProduces('application/vnd.apple.mpegurl')
  @ApiOkResponse({ description: 'Variant playlist', content: PLAYLIST_RESPONSE_CONTENT })
  @ApiBadRequestResponse({ description: 'validation_failed (unknown rendition name)' })
  @ApiNotFoundResponse({ description: `${NESTED_404} / not_found (rendition)` })
  @ApiConflictResponse({ description: 'media_not_ready' })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not a VIDEO lecture)' })
  async variantPlaylist(
    @Param({ schema: LectureVariantPlaylistParamsSchema }) params: LectureVariantPlaylistParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const body = await this.playlists.variant(
      {
        source: { kind: 'working', courseId: params.courseId },
        lectureId: params.lectureId,
        viewer,
      },
      params.rendition,
    );
    return sendPlaylist(res, body, PLAYLIST_NO_STORE);
  }

  @Get('lectures/:lectureId/download')
  @CheckPolicy({ resource: 'course', action: 'read', id: courseIdOf })
  @ApiOperation({ summary: 'Presigned download of a working-copy RESOURCE lecture (attachment)' })
  @ApiOkResponse({ standardSchema: LectureDownloadResponseSchema })
  @ApiBadRequestResponse({ description: 'validation_failed' })
  @ApiNotFoundResponse({ description: NESTED_404 })
  @ApiConflictResponse({ description: 'media_not_ready (no file, or still processing)' })
  @ApiUnprocessableEntityResponse({ description: 'lecture_type_mismatch (not a RESOURCE)' })
  download(
    @Param({ schema: LectureParamsSchema }) params: LectureParams,
    @PlaybackViewerParam() viewer: PlaybackViewer | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LectureDownloadResponse> {
    noStore(res);
    return this.downloads.execute({
      source: { kind: 'working', courseId: params.courseId },
      lectureId: params.lectureId,
      viewer,
    });
  }
}
