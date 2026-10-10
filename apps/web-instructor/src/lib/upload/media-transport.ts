import {
  AssetViewSchema,
  InitiateUploadResponseSchema,
  PresignPartsResponseSchema,
  UploadStatusSchema,
} from '@udemy/contracts';

import { api } from '../api';
import type { UploadTransport } from './upload-engine';

const enc = encodeURIComponent;

/** The media upload endpoints of design §8, through this app's BFF proxy. */
export const mediaTransport: UploadTransport = {
  initiate: (body) =>
    api('/media/uploads', { method: 'POST', json: body, schema: InitiateUploadResponseSchema }),
  status: (assetId) => api(`/media/uploads/${enc(assetId)}`, { schema: UploadStatusSchema }),
  partUrls: (assetId, partNumbers) =>
    api(`/media/uploads/${enc(assetId)}/part-urls`, {
      method: 'POST',
      json: { partNumbers },
      schema: PresignPartsResponseSchema,
    }),
  complete: (assetId) =>
    api(`/media/uploads/${enc(assetId)}/complete`, {
      method: 'POST',
      json: {},
      schema: AssetViewSchema,
    }),
  abort: (assetId) => api(`/media/uploads/${enc(assetId)}`, { method: 'DELETE' }),
};
