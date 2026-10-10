/**
 * Presigned S3/MinIO URLs are bearer capabilities (design §9 "Audit": "pino redact gains `*.url`
 * on presign responses"). Logging the object path is useful, logging the signature is a leak, so
 * the logger keeps the URL and strips its signing query parameters:
 * `https://s3/b/k?X-Amz-Signature=…&X-Amz-Credential=…&partNumber=1` -> `https://s3/b/k?partNumber=1`.
 */

/** SigV4 (`X-Amz-*`, any case) and legacy SigV2 query-string auth parameters. */
const SIGNING_PARAM = /^(x-amz-.*|signature|awsaccesskeyid)$/i;

/** An `http(s)://` URL inside arbitrary text (a JSON value, a playlist line, an error message). */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>`]+/gi;

/** Nesting limit for `sanitizePresignedUrls`; anything deeper is replaced (fail closed). */
export const PRESIGNED_SANITIZE_MAX_DEPTH = 8;

const TOO_DEEP = '[REDACTED: too deep]';

function signingParams(url: URL): string[] {
  return [...url.searchParams.keys()].filter((name) => SIGNING_PARAM.test(name));
}

/**
 * True for an absolute http(s) URL that carries query-string auth: `X-Amz-Signature` or
 * `X-Amz-Credential` (SigV4), or `Signature` (SigV2).
 */
export function isPresignedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return signingParams(url).some((name) =>
    /^(x-amz-signature|x-amz-credential|signature)$/i.test(name),
  );
}

/**
 * Removes every signing parameter (`X-Amz-*`, `Signature`, `AWSAccessKeyId`) from a presigned
 * URL. Other values (non-presigned URLs, non-URLs) are returned unchanged.
 */
export function stripPresignedQuery(value: string): string {
  if (!isPresignedUrl(value)) return value;
  const url = new URL(value);
  for (const name of signingParams(url)) url.searchParams.delete(name);
  return url.toString();
}

/** `stripPresignedQuery` applied to every URL embedded in `text`. */
export function stripPresignedUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => stripPresignedQuery(match));
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export interface SanitizePresignedUrlsOptions {
  /** Object keys whose values are replaced by `censor` wherever they occur (e.g. `password`). */
  readonly censorKeys?: ReadonlySet<string>;
  /** Replacement for `censorKeys` values. Default `[REDACTED]`. */
  readonly censor?: string;
}

/**
 * A copy of `value` with the signing parameters stripped from every presigned URL in every
 * string, through plain objects and arrays (other objects are kept as they are), and the values
 * of `censorKeys` censored. Deeper than `PRESIGNED_SANITIZE_MAX_DEPTH` levels the value is
 * replaced, so nothing unchecked is logged.
 */
export function sanitizePresignedUrls(
  value: unknown,
  options: SanitizePresignedUrlsOptions = {},
): unknown {
  return sanitize(value, options, 0);
}

function sanitize(value: unknown, options: SanitizePresignedUrlsOptions, depth: number): unknown {
  if (typeof value === 'string') return stripPresignedUrlsInText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= PRESIGNED_SANITIZE_MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, options, depth + 1));
  if (!isPlainObject(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] =
      options.censorKeys?.has(key) === true
        ? (options.censor ?? '[REDACTED]')
        : sanitize(item, options, depth + 1);
  }
  return copy;
}
