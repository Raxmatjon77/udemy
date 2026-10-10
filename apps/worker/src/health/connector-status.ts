import { z } from 'zod';

/** Shape of `GET /connectors/{name}/status` (Kafka Connect REST API), the fields we use. */
const ConnectorStatusSchema = z.object({
  name: z.string(),
  connector: z.object({ state: z.string(), worker_id: z.string().optional() }),
  tasks: z.array(
    z.object({
      id: z.number(),
      state: z.string(),
      worker_id: z.string().optional(),
      trace: z.string().optional(),
    }),
  ),
});

export interface ConnectorTaskState {
  readonly id: number;
  readonly state: string;
  /** First line of the task's stack trace (FAILED tasks only), shortened. */
  readonly error?: string;
}

export type ConnectorCheck =
  | {
      readonly ok: true;
      readonly connector: string;
      readonly state: string;
      readonly tasks: readonly ConnectorTaskState[];
    }
  | {
      readonly ok: false;
      readonly connector: string;
      readonly state?: string;
      readonly tasks?: readonly ConnectorTaskState[];
      /** Operator-facing: what is wrong and what to do. */
      readonly message: string;
    };

const MAX_ERROR_LENGTH = 200;

function firstLine(trace: string | undefined): string | undefined {
  const line = trace?.split('\n', 1)[0]?.trim();
  if (line === undefined || line === '') return undefined;
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH)}…` : line;
}

/** Restart hint per state; see "Event pipeline operations" in infra/docker/README.md. */
function hint(state: string, name: string): string {
  switch (state) {
    case 'FAILED':
      return `restart it: POST /connectors/${name}/restart?includeTasks=true&onlyFailed=true`;
    case 'UNASSIGNED':
      return 'Kafka Connect has not (re)assigned it, typically after Kafka was down: restart the Kafka Connect worker';
    case 'PAUSED':
      return `it was paused: PUT /connectors/${name}/resume`;
    default:
      return 'check the Kafka Connect logs';
  }
}

/**
 * Asks Kafka Connect for the connector and task states. Everything other than "connector and
 * all tasks RUNNING" is reported as not ok with a message that says what to do.
 */
export async function checkConnector(
  baseUrl: string,
  name: string,
  options: { timeoutMs: number; fetchFn?: typeof fetch },
): Promise<ConnectorCheck> {
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/connectors/${encodeURIComponent(name)}/status`, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'error';
    return { ok: false, connector: name, message: `Kafka Connect is unreachable (${reason})` };
  }
  if (response.status === 404) {
    return {
      ok: false,
      connector: name,
      message: `Connector ${name} is not registered in Kafka Connect (re-run debezium-init)`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      connector: name,
      message: `Kafka Connect answered HTTP ${response.status}`,
    };
  }
  const parsed = ConnectorStatusSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    return { ok: false, connector: name, message: 'Unexpected Kafka Connect status response' };
  }

  const { connector, tasks: rawTasks } = parsed.data;
  const tasks: ConnectorTaskState[] = rawTasks.map((t) => {
    const error = t.state === 'FAILED' ? firstLine(t.trace) : undefined;
    return error === undefined ? { id: t.id, state: t.state } : { id: t.id, state: t.state, error };
  });
  const problems: string[] = [];
  if (connector.state !== 'RUNNING') {
    problems.push(`connector ${name} is ${connector.state}: ${hint(connector.state, name)}`);
  }
  if (tasks.length === 0 && connector.state === 'RUNNING') {
    problems.push(`connector ${name} has no tasks`);
  }
  for (const t of tasks) {
    if (t.state === 'RUNNING') continue;
    const detail = t.error === undefined ? '' : ` (${t.error})`;
    problems.push(`task ${t.id} is ${t.state}${detail}: ${hint(t.state, name)}`);
  }
  if (problems.length === 0) return { ok: true, connector: name, state: connector.state, tasks };
  return {
    ok: false,
    connector: name,
    state: connector.state,
    tasks,
    message: `Debezium ${problems.join('; ')}`,
  };
}
