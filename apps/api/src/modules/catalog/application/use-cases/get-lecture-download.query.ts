import { Injectable } from '@nestjs/common';
import type { SignedUrl } from '@udemy/contracts';
import { MediaFacade, MediaNotReady } from '../../../media';
import type { PlaybackViewer } from '../../domain/playback-access';
import { LectureAccessAuthorizer, type LectureSource } from '../lecture-access.authorizer';

export interface LectureDownloadInput {
  readonly source: LectureSource;
  readonly lectureId: string;
  readonly viewer: PlaybackViewer | null;
}

/**
 * `GetLectureDownload` (design §5): a presigned `attachment` + `application/octet-stream` GET
 * (D11, TTL `MEDIA_DOWNLOAD_URL_TTL_S`) of a RESOURCE lecture's file. Free previews do not
 * apply to downloads: owner, moderator or entitled only on the live route.
 *
 * The suggested filename is the uploader's sanitized original name (display only, RFC 5987
 * encoded by media), falling back to the lecture title.
 */
@Injectable()
export class GetLectureDownloadQuery {
  constructor(
    private readonly authorizer: LectureAccessAuthorizer,
    private readonly media: MediaFacade,
  ) {}

  async execute(input: LectureDownloadInput): Promise<SignedUrl> {
    const lecture = await this.authorizer.authorize({ ...input, use: 'download' });
    if (lecture.mediaAssetId === null) throw new MediaNotReady();
    const [asset] = await this.media.getAssets([lecture.mediaAssetId]);
    return this.media.presignDownload(
      lecture.mediaAssetId,
      asset?.originalFilename ?? lecture.title,
    );
  }
}
