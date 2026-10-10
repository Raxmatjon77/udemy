import { Injectable } from '@nestjs/common';
import { MediaFacade, MediaNotReady } from '../../../media';
import type { PlaybackViewer } from '../../domain/playback-access';
import { LectureAccessAuthorizer, type LectureSource } from '../lecture-access.authorizer';

export interface LecturePlaylistInput {
  readonly source: LectureSource;
  readonly lectureId: string;
  readonly viewer: PlaybackViewer | null;
}

/**
 * HLS playback of a VIDEO lecture (design D7, §5): authorize against the requested source
 * (live revision, working copy or revision under review), then let media render the master
 * (relative variant URIs) or a variant (segments rewritten to presigned GETs).
 *
 * Errors: the authorizer's 404/403/422; 409 `media_not_ready` when nothing READY is attached
 * (a working-copy lecture that is still uploading or processing); 404 for an unknown rendition.
 */
@Injectable()
export class GetLecturePlaylistQuery {
  constructor(
    private readonly authorizer: LectureAccessAuthorizer,
    private readonly media: MediaFacade,
  ) {}

  async master(input: LecturePlaylistInput): Promise<string> {
    return this.media.renderMasterPlaylist(await this.videoAssetId(input));
  }

  async variant(input: LecturePlaylistInput, rendition: string): Promise<string> {
    return this.media.renderVariantPlaylist(await this.videoAssetId(input), rendition);
  }

  private async videoAssetId(input: LecturePlaylistInput): Promise<string> {
    const lecture = await this.authorizer.authorize({ ...input, use: 'stream' });
    if (lecture.mediaAssetId === null) throw new MediaNotReady();
    return lecture.mediaAssetId;
  }
}
