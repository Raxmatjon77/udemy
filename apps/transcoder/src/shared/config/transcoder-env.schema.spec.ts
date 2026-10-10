import { EnvValidationError, validateEnv } from '@udemy/nest-common';
import { describe, expect, it } from 'vitest';
import { storageConfigFromTranscoderEnv, transcoderEnvSchema } from './transcoder-env.schema';

const validEnv = {
  DATABASE_URL: 'postgres://udemy:udemy@localhost:5432/udemy',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'minio',
  S3_SECRET_KEY: 'minio12345',
  S3_BUCKET_UPLOADS: 'udemy-uploads',
  S3_BUCKET_MEDIA: 'udemy-media',
};

describe('transcoderEnvSchema', () => {
  it('applies the documented defaults', () => {
    expect(validateEnv(transcoderEnvSchema, validEnv)).toMatchObject({
      TRANSCODER_FFMPEG_PATH: 'ffmpeg',
      TRANSCODER_FFPROBE_PATH: 'ffprobe',
      TRANSCODER_CONCURRENCY: 1,
      TRANSCODER_POLL_INTERVAL_MS: 5000,
      TRANSCODER_LEASE_MS: 120000,
      TRANSCODER_THREADS: 0,
      TRANSCODER_MAX_HEIGHT: 1080,
      TRANSCODER_TIMEOUT_FACTOR: 4,
      TRANSCODER_MAX_SOURCE_SECONDS: 14400,
      TRANSCODER_MAX_ATTEMPTS: 3,
      TRANSCODER_TMP_DIR: '/tmp/udemy-transcoder',
      TRANSCODER_HEALTH_PORT: 4002,
      TRANSCODER_SPRITES_ENABLED: true,
      S3_FORCE_PATH_STYLE: true,
    });
  });

  it('accepts the .env.example / image values', () => {
    const env = validateEnv(transcoderEnvSchema, {
      ...validEnv,
      S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
      TRANSCODER_FFMPEG_PATH: '/usr/bin/ffmpeg',
      TRANSCODER_FFPROBE_PATH: '/usr/bin/ffprobe',
      TRANSCODER_MAX_HEIGHT: '720',
      TRANSCODER_THREADS: '1',
      TRANSCODER_TMP_DIR: '/tmp/transcoder',
      TRANSCODER_SPRITES_ENABLED: 'false',
      TRANSCODER_TIMEOUT_FACTOR: '2.5',
    });
    expect(env).toMatchObject({
      TRANSCODER_MAX_HEIGHT: 720,
      TRANSCODER_SPRITES_ENABLED: false,
      TRANSCODER_TIMEOUT_FACTOR: 2.5,
    });
    expect(storageConfigFromTranscoderEnv(env)).toMatchObject({
      endpoint: 'http://localhost:9000',
      publicEndpoint: 'http://127.0.0.1:9000',
      forcePathStyle: true,
      buckets: { uploads: 'udemy-uploads', media: 'udemy-media' },
    });
  });

  it.each([
    ['TRANSCODER_FFMPEG_PATH', 'ffmpeg -i x'],
    ['TRANSCODER_FFMPEG_PATH', 'bin/ffmpeg'],
    ['TRANSCODER_FFPROBE_PATH', '$(id)'],
    ['TRANSCODER_TMP_DIR', 'relative/dir'],
    ['TRANSCODER_TMP_DIR', '/'],
    ['TRANSCODER_CONCURRENCY', '0'],
    ['TRANSCODER_LEASE_MS', '1000'],
    ['TRANSCODER_MAX_HEIGHT', '240'],
    ['TRANSCODER_THREADS', '-1'],
    ['TRANSCODER_HEALTH_PORT', '70000'],
    ['TRANSCODER_MAX_ATTEMPTS', '11'],
    ['S3_ENDPOINT', 'ftp://minio:9000'],
    ['S3_ENDPOINT', 'http://minio:9000/path'],
    ['S3_BUCKET_MEDIA', 'udemy-uploads'],
    ['DATABASE_URL', 'mysql://x'],
  ])('rejects %s=%s', (key, value) => {
    const run = (): unknown => validateEnv(transcoderEnvSchema, { ...validEnv, [key]: value });
    expect(run).toThrow(EnvValidationError);
  });

  it.each(['DATABASE_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_BUCKET_UPLOADS'])(
    'requires %s',
    (key) => {
      const env: Record<string, string> = { ...validEnv };
      delete env[key];
      expect(() => validateEnv(transcoderEnvSchema, env)).toThrow(new RegExp(key));
    },
  );
});
