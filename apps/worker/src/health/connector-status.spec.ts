import { describe, expect, it, vi } from 'vitest';
import { checkConnector } from './connector-status';

const URL_ = 'http://connect:8083';

function respond(status: number, body?: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

const status = (connector: string, ...tasks: { state: string; trace?: string }[]) => ({
  name: 'udemy-outbox',
  connector: { state: connector, worker_id: '172.20.0.7:8083' },
  tasks: tasks.map((t, id) => ({ id, worker_id: '172.20.0.7:8083', ...t })),
  type: 'source',
});

describe('checkConnector', () => {
  it('is ok when the connector and every task are RUNNING', async () => {
    const fetchFn = respond(200, status('RUNNING', { state: 'RUNNING' }));

    await expect(
      checkConnector(URL_, 'udemy-outbox', { timeoutMs: 1000, fetchFn }),
    ).resolves.toEqual({
      ok: true,
      connector: 'udemy-outbox',
      state: 'RUNNING',
      tasks: [{ id: 0, state: 'RUNNING' }],
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://connect:8083/connectors/udemy-outbox/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('reports a FAILED task with the first trace line and the restart call', async () => {
    const trace =
      'org.apache.kafka.connect.errors.ConnectException: relation "outbox.events" does not exist\n\tat io.debezium...';
    const result = await checkConnector(URL_, 'udemy-outbox', {
      timeoutMs: 1000,
      fetchFn: respond(200, status('RUNNING', { state: 'FAILED', trace })),
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      tasks: [
        {
          id: 0,
          state: 'FAILED',
          error:
            'org.apache.kafka.connect.errors.ConnectException: relation "outbox.events" does not exist',
        },
      ],
    });
    expect(!result.ok && result.message).toContain('task 0 is FAILED');
    expect(!result.ok && result.message).toContain(
      'POST /connectors/udemy-outbox/restart?includeTasks=true&onlyFailed=true',
    );
  });

  it('tells to restart Kafka Connect when the connector is UNASSIGNED', async () => {
    const result = await checkConnector(URL_, 'udemy-outbox', {
      timeoutMs: 1000,
      fetchFn: respond(200, status('UNASSIGNED')),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/UNASSIGNED.*restart the Kafka Connect worker/);
  });

  it('reports an unregistered connector, an HTTP error and an unreachable Connect', async () => {
    const notFound = await checkConnector(URL_, 'udemy-outbox', {
      timeoutMs: 1000,
      fetchFn: respond(404, { error_code: 404 }),
    });
    expect(!notFound.ok && notFound.message).toContain('not registered');

    const serverError = await checkConnector(URL_, 'udemy-outbox', {
      timeoutMs: 1000,
      fetchFn: respond(500, {}),
    });
    expect(!serverError.ok && serverError.message).toContain('HTTP 500');

    const down = await checkConnector(URL_, 'udemy-outbox', {
      timeoutMs: 1000,
      fetchFn: vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch,
    });
    expect(!down.ok && down.message).toBe('Kafka Connect is unreachable (TypeError)');
  });

  it('rejects a body that is not a connector status', async () => {
    const result = await checkConnector(URL_, 'udemy-outbox', {
      timeoutMs: 1000,
      fetchFn: respond(200, { hello: 'world' }),
    });
    expect(!result.ok && result.message).toBe('Unexpected Kafka Connect status response');
  });
});
