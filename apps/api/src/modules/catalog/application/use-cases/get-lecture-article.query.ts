import { Injectable } from '@nestjs/common';
import type { PublicArticle } from '@udemy/contracts';
import type { PlaybackViewer } from '../../domain/playback-access';
import { LectureAccessAuthorizer, type LectureSource } from '../lecture-access.authorizer';

export interface LectureArticleInput {
  /** `live` (public) or `revision` (moderators); the working copy has `GetArticleQuery`. */
  readonly source: Exclude<LectureSource, { readonly kind: 'working' }>;
  readonly lectureId: string;
  readonly viewer: PlaybackViewer | null;
}

/**
 * `GetPublicLectureArticle` (design §5): the markdown of an ARTICLE lecture as frozen in the
 * live revision (same rules as playback: preview, owner, moderator or entitled) or in a
 * revision under review (moderators). Clients render it with `<MarkdownView>` (sanitized).
 */
@Injectable()
export class GetLectureArticleQuery {
  constructor(private readonly authorizer: LectureAccessAuthorizer) {}

  async execute(input: LectureArticleInput): Promise<PublicArticle> {
    const lecture = await this.authorizer.authorize({ ...input, use: 'article' });
    return { bodyMd: lecture.articleBodyMd ?? '' };
  }
}
