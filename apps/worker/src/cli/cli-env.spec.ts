import { EnvValidationError } from '@udemy/nest-common';
import { describe, expect, it } from 'vitest';
import { loadCliEnv } from './cli-env';

describe('loadCliEnv', () => {
  it('needs only the Kafka settings and applies the worker defaults', () => {
    expect(
      loadCliEnv({ NODE_ENV: 'test', KAFKA_BROKERS: 'localhost:9092,kafka:19092' }),
    ).toMatchObject({
      KAFKA_BROKERS: ['localhost:9092', 'kafka:19092'],
      KAFKA_CLIENT_ID: 'udemy-worker',
      KAFKA_GROUP_ID: 'udemy-worker',
      PROCESSED_EVENTS_RETENTION_DAYS: 30,
    });
  });

  it('rejects a missing broker list and a too short dedupe window', () => {
    expect(() => loadCliEnv({ NODE_ENV: 'test' })).toThrow(EnvValidationError);
    expect(() =>
      loadCliEnv({
        NODE_ENV: 'test',
        KAFKA_BROKERS: 'localhost:9092',
        PROCESSED_EVENTS_RETENTION_DAYS: '3',
      }),
    ).toThrow(/PROCESSED_EVENTS_RETENTION_DAYS/);
  });
});
