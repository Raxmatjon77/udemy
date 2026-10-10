import { Injectable } from '@nestjs/common';
import type { AssetPage } from '@udemy/contracts';
import { type AuthorizationSubject, Authorizer } from '../../../access';
import { MediaReadForbidden } from '../../domain/media.errors';
import { decodeAssetCursor, encodeAssetCursor } from '../asset-cursor';
import { MediaAssetRepository } from '../ports/media-asset.repository';
import { toAssetView } from '../views';

export interface ListAssetsInput {
  readonly principal: AuthorizationSubject;
  /** `?ids=a,b,c` (≤ 50): those assets, foreign ones silently omitted (design §8). */
  readonly ids?: readonly string[];
  /** Without `ids`: one keyset page, newest first. */
  readonly cursor?: string;
  readonly limit: number;
  /** Admins only: restrict the page to one owner. Ignored for `:own` callers. */
  readonly ownerId?: string;
}

/**
 * `GET /media/assets` (design §8 + §14 amendment): allowed with `media_asset:read:own`
 * (instructors: only their own assets) OR `media_asset:read:any` (admins: everyone's). There is
 * no "any of" route marker, so the route is `@AuthenticatedOnly` and this use case decides with
 * the Authorizer: neither permission -> 403 `forbidden`.
 *
 * With `ids` the answer keeps the request order. Without, it is a keyset page over
 * `(created_at DESC, id DESC)` with an exact-text timestamp cursor.
 */
@Injectable()
export class ListAssetsQuery {
  constructor(
    private readonly assets: MediaAssetRepository,
    private readonly authorizer: Authorizer,
  ) {}

  async execute(input: ListAssetsInput): Promise<AssetPage> {
    const any = this.authorizer.can(input.principal, 'media_asset:read:any');
    const own = this.authorizer.can(input.principal, 'media_asset:read:own');
    if (!any && !own) throw new MediaReadForbidden();
    const visible = (ownerId: string): boolean => any || ownerId === input.principal.userId;

    if (input.ids !== undefined) {
      const found = await this.assets.findByIds(input.ids);
      const byId = new Map(found.filter((a) => visible(a.ownerId)).map((a) => [a.id, a]));
      const items = input.ids.flatMap((id) => {
        const asset = byId.get(id);
        return asset === undefined ? [] : [toAssetView(asset)];
      });
      return { items, nextCursor: null };
    }

    const ownerId = any ? (input.ownerId ?? null) : input.principal.userId;
    const after = input.cursor === undefined ? null : decodeAssetCursor(input.cursor);
    const rows = await this.assets.listPage({ ownerId, after, limit: input.limit + 1 });
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > input.limit && last !== undefined
        ? encodeAssetCursor({ createdAt: last.createdAtText, id: last.id })
        : null;
    return { items: page.map(toAssetView), nextCursor };
  }
}
