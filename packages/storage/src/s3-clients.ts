import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { type StorageConfig, validateStorageConfig } from './config';

export interface S3Clients {
  /** `S3_ENDPOINT`: every network call (server to MinIO). */
  readonly internal: S3Client;
  /**
   * `S3_PUBLIC_ENDPOINT`: presigning only (local HMAC, no network). SigV4 binds the host, so URLs
   * the browser calls must be signed for the host the browser uses.
   */
  readonly public: S3Client;
}

export const DEFAULT_CONNECTION_TIMEOUT_MS = 3_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

function clientConfig(config: StorageConfig, endpoint: string): S3ClientConfig {
  return {
    endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    // Since SDK 3.729 the default is WHEN_SUPPORTED, which (a) bakes
    // `x-amz-checksum-crc32=AAAAAA==` (the CRC of an EMPTY body) plus
    // `x-amz-sdk-checksum-algorithm` into presigned UploadPart URLs, so every real browser PUT
    // would fail, and (b) adds flexible-checksum trailers MinIO/S3-compatibles handle unevenly.
    // WHEN_REQUIRED keeps checksums only for operations that mandate one (DeleteObjects).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {
      connectionTimeout: config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      requestTimeout: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    },
  };
}

/** Builds the internal and public S3 clients. Call `destroyS3Clients` on shutdown. */
export function createS3Clients(config: StorageConfig): S3Clients {
  const valid = validateStorageConfig(config);
  return {
    internal: new S3Client(clientConfig(valid, valid.endpoint)),
    public: new S3Client(clientConfig(valid, valid.publicEndpoint)),
  };
}

export function destroyS3Clients(clients: S3Clients): void {
  clients.internal.destroy();
  clients.public.destroy();
}
