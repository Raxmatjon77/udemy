import { ValidationError } from '@udemy/nest-common/errors';
import { beforeEach, describe, expect, it } from 'vitest';
import { MediaAssetNotFound, MediaReadForbidden } from '../../domain/media.errors';
import { decodeAssetCursor, encodeAssetCursor } from '../asset-cursor';
import { assetRecord, principal } from '../testing/media.fakes';
import { createMediaHarness, type MediaHarness } from '../testing/media.harness';

const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';
const ADMIN = '00000000-0000-7000-8000-0000000000ad';

const instructorA = principal(A, 'media_asset:read:own', 'media_asset:create');
const instructorB = principal(B, 'media_asset:read:own');
const admin = principal(ADMIN, 'media_asset:read:any');
const student = principal('00000000-0000-7000-8000-0000000000ff');

describe('GetAsset', () => {
  let h: MediaHarness;
  beforeEach(() => {
    h = createMediaHarness();
  });

  it('returns the view to the owner and to an admin, 404 to anyone else', async () => {
    const asset = h.assets.add(
      assetRecord({
        ownerId: A,
        status: 'PROCESSING',
        progressPct: 42,
        purpose: 'LECTURE_VIDEO',
      }),
    );

    const own = await h.getAsset.execute({ principal: instructorA, assetId: asset.id });
    expect(own).toMatchObject({ id: asset.id, ownerId: A, status: 'PROCESSING', progressPct: 42 });
    await expect(h.getAsset.execute({ principal: admin, assetId: asset.id })).resolves.toEqual(own);
    await expect(
      h.getAsset.execute({ principal: instructorB, assetId: asset.id }),
    ).rejects.toBeInstanceOf(MediaAssetNotFound);
    await expect(h.getAsset.execute({ principal: admin, assetId: B })).rejects.toBeInstanceOf(
      MediaAssetNotFound,
    );
  });

  it('maps READY video facts and hides progress outside PROCESSING', async () => {
    const asset = h.assets.add(
      assetRecord({
        ownerId: A,
        status: 'READY',
        progressPct: 100,
        durationMs: 61_499,
        width: 1280,
        height: 720,
        outputPrefix: 'assets/x/a1/',
        renditions: ['360p', 'poster'],
      }),
    );
    expect(await h.getAsset.execute({ principal: instructorA, assetId: asset.id })).toMatchObject({
      progressPct: null,
      durationSeconds: 61,
      width: 1280,
      height: 720,
      renditions: ['360p', 'poster'],
      failureCode: null,
      purged: false,
    });
  });
});

describe('ListAssets (own OR any, design §14)', () => {
  let h: MediaHarness;
  const ids: string[] = [];

  beforeEach(() => {
    h = createMediaHarness();
    ids.length = 0;
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        h.assets.add(
          assetRecord({
            ownerId: i % 2 === 0 ? A : B,
            createdAt: new Date(Date.UTC(2026, 9, 10, 10, 0, i)),
          }),
        ).id,
      );
    }
  });

  it('refuses a principal with neither permission (403 forbidden)', async () => {
    await expect(h.listAssets.execute({ principal: student, limit: 20 })).rejects.toBeInstanceOf(
      MediaReadForbidden,
    );
  });

  it('pages only the caller’s assets for :own, newest first, with a keyset cursor', async () => {
    const first = await h.listAssets.execute({ principal: instructorA, limit: 2 });
    expect(first.items.map((a) => a.id)).toEqual([ids[4], ids[2]]);
    expect(first.nextCursor).not.toBeNull();

    const second = await h.listAssets.execute({
      principal: instructorA,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((a) => a.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it('ignores ownerId for :own callers and honours it for admins', async () => {
    const own = await h.listAssets.execute({ principal: instructorA, limit: 20, ownerId: B });
    expect(own.items.every((a) => a.ownerId === A)).toBe(true);

    const all = await h.listAssets.execute({ principal: admin, limit: 20 });
    expect(all.items).toHaveLength(5);
    const ofB = await h.listAssets.execute({ principal: admin, limit: 20, ownerId: B });
    expect(ofB.items.map((a) => a.id)).toEqual([ids[3], ids[1]]);
  });

  it('answers ?ids= in request order, omitting foreign and unknown ids', async () => {
    const unknown = '00000000-0000-7000-8000-000000009999';
    const res = await h.listAssets.execute({
      principal: instructorA,
      limit: 20,
      ids: [ids[2] ?? '', ids[1] ?? '', unknown, ids[0] ?? ''],
    });
    expect(res).toEqual({
      items: [expect.objectContaining({ id: ids[2] }), expect.objectContaining({ id: ids[0] })],
      nextCursor: null,
    });
    const asAdmin = await h.listAssets.execute({
      principal: admin,
      limit: 20,
      ids: [ids[1] ?? '', ids[2] ?? ''],
    });
    expect(asAdmin.items.map((a) => a.id)).toEqual([ids[1], ids[2]]);
  });
});

describe('asset cursor', () => {
  it('round-trips the exact microsecond text', () => {
    const keyset = { createdAt: '2026-10-10T10:00:00.123456Z', id: A };
    expect(decodeAssetCursor(encodeAssetCursor(keyset))).toEqual(keyset);
  });

  it.each(['%%%', Buffer.from('{"c":"2026-10-10T10:00:00.123Z","i":"x"}').toString('base64url')])(
    'rejects a cursor it did not produce (%s)',
    (cursor) => {
      expect(() => decodeAssetCursor(cursor)).toThrow(ValidationError);
    },
  );
});
