import 'server-only';
import {
  CertificateCodeSchema,
  CertificateVerificationSchema,
  type CertificateVerification,
} from '@udemy/contracts';
import { cache } from 'react';

import { getJson } from '../catalog/server';

/**
 * `GET /certificates/:code` (public verification, design D7): anonymous like the catalog, so
 * the page is the same for everybody. Null for an unknown or malformed code (404). Memoised per
 * request: `generateMetadata` and the page share one call.
 */
export const getCertificateVerification = cache(
  async (code: string): Promise<CertificateVerification | null> => {
    if (!CertificateCodeSchema.safeParse(code).success) return null;
    return getJson(`/certificates/${code}`, CertificateVerificationSchema, {
      notFoundAsNull: true,
    });
  },
);
