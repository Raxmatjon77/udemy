import {
  checkMediaUpload,
  ErrorCode,
  MEDIA_PURPOSE_RULES,
  type MediaPurpose,
  type MediaPurposeRule,
} from '@udemy/contracts';
import { UnsupportedMediaType, UploadTooLarge } from './media.errors';

/** Env limits per purpose (`MEDIA_MAX_{VIDEO,IMAGE,RESOURCE}_BYTES`). */
export type PurposeByteLimits = Readonly<Record<MediaPurpose, number>>;

export interface AcceptedUpload {
  readonly purpose: MediaPurpose;
  /** The allowlisted, lowercased type: the only value ever sent to S3 as Content-Type. */
  readonly contentType: string;
  readonly sizeBytes: number;
}

/**
 * Purpose policy (design §4): the shared `MEDIA_PURPOSE_RULES` from contracts (the UI
 * pre-validates with the same table), tightened by the api's env limits. An env value can only
 * LOWER a limit, never raise it above the contract ceiling.
 */
export class PurposePolicy {
  constructor(private readonly envLimits: PurposeByteLimits) {}

  rule(purpose: MediaPurpose): MediaPurposeRule {
    return MEDIA_PURPOSE_RULES[purpose];
  }

  /** Effective max declared size of `purpose`. */
  maxBytes(purpose: MediaPurpose): number {
    return Math.min(this.rule(purpose).maxBytes, this.envLimits[purpose]);
  }

  /**
   * @throws UnsupportedMediaType (422) when the declared type is not allowed for the purpose
   * @throws UploadTooLarge (422) when the declared size exceeds the effective limit
   */
  accept(purpose: MediaPurpose, contentType: string, sizeBytes: number): AcceptedUpload {
    const verdict = checkMediaUpload(purpose, contentType, sizeBytes, this.maxBytes(purpose));
    if (verdict === ErrorCode.UnsupportedMediaType) throw new UnsupportedMediaType(purpose);
    if (verdict === ErrorCode.UploadTooLarge) throw new UploadTooLarge(this.maxBytes(purpose));
    return { purpose, contentType: contentType.trim().toLowerCase(), sizeBytes };
  }
}
