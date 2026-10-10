import { CliUsageError } from '../cli-usage.error';

export const DLQ_LIST_COMMAND = 'dlq:list';
export const DLQ_REPLAY_COMMAND = 'dlq:replay';

export const DLQ_USAGE = [
  'Usage:',
  `  pnpm --filter @udemy/worker cli ${DLQ_LIST_COMMAND} <topic>.dlq [--limit <n>] [--preview <chars>]`,
  `  pnpm --filter @udemy/worker cli ${DLQ_REPLAY_COMMAND} <topic>.dlq (--event-id <uuid> | --all) [--dry-run] [--allow-stale]`,
  '',
  `${DLQ_LIST_COMMAND}    Prints the oldest messages of a DLQ topic as JSON lines: offset, key, eventType/eventId,`,
  '               the dlq.* error headers and a payload preview (default 200 chars, the rest redacted).',
  '               --limit defaults to 20 (max 1000).',
  `${DLQ_REPLAY_COMMAND}  Republishes DLQ messages to the original topic (key, value, headers minus dlq.*,`,
  '               original partition). Idempotent consumers re-run only the handlers that failed.',
  '               --dry-run prints what would be replayed. --allow-stale also replays messages older',
  '               than PROCESSED_EVENTS_RETENTION_DAYS (skipped by default).',
  '',
  'Run `pnpm --filter @udemy/worker build` first. Every invocation reads through its own',
  'throw-away consumer group (never the worker group) and commits nothing.',
  'Exit codes: 0 ok, 1 failed, 2 bad command line.',
].join('\n');

export interface DlqListArgs {
  readonly command: typeof DLQ_LIST_COMMAND;
  readonly topic: string;
  readonly limit: number;
  readonly previewChars: number;
}

export interface DlqReplayArgs {
  readonly command: typeof DLQ_REPLAY_COMMAND;
  readonly topic: string;
  readonly eventId: string | undefined;
  readonly dryRun: boolean;
  readonly allowStale: boolean;
}

export type DlqArgs = DlqListArgs | DlqReplayArgs;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Splits argv into the positional arguments and `--flag [value]` pairs. */
function tokenize(
  argv: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
): { positional: string[]; values: Map<string, string>; booleans: Set<string> } {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (booleanFlags.includes(flag)) {
      if (eq !== -1) throw new CliUsageError(`${flag} takes no value.`);
      booleans.add(flag);
      continue;
    }
    if (!valueFlags.includes(flag)) throw new CliUsageError(`Unknown argument: ${arg}`);
    let value: string | undefined;
    if (eq === -1) {
      value = argv[i + 1];
      i += 1;
    } else {
      value = arg.slice(eq + 1);
    }
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      throw new CliUsageError(`${flag} needs a value.`);
    }
    if (values.has(flag)) throw new CliUsageError(`${flag} given twice.`);
    values.set(flag, value);
  }
  return { positional, values, booleans };
}

function positiveInt(flag: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new CliUsageError(`${flag} must be an integer in 1..${max}, got "${raw}".`);
  }
  return n;
}

function singleTopic(positional: readonly string[]): string {
  if (positional.length === 0) throw new CliUsageError('The DLQ topic is required.');
  if (positional.length > 1) throw new CliUsageError(`Unexpected argument: ${positional[1]}`);
  return positional[0] ?? '';
}

/** Parses `<command> ...args`. Throws CliUsageError (exit code 2) on any mistake. */
export function parseDlqArgs(command: string, argv: readonly string[]): DlqArgs {
  if (command === DLQ_LIST_COMMAND) {
    const t = tokenize(argv, ['--limit', '--preview'], []);
    return {
      command,
      topic: singleTopic(t.positional),
      limit: positiveInt('--limit', t.values.get('--limit'), 20, 1_000),
      previewChars: positiveInt('--preview', t.values.get('--preview'), 200, 10_000),
    };
  }
  if (command === DLQ_REPLAY_COMMAND) {
    const t = tokenize(argv, ['--event-id'], ['--all', '--dry-run', '--allow-stale']);
    const eventId = t.values.get('--event-id');
    const all = t.booleans.has('--all');
    if ((eventId === undefined) === !all) {
      throw new CliUsageError('Give exactly one of --event-id <uuid> or --all.');
    }
    if (eventId !== undefined && !UUID.test(eventId)) {
      throw new CliUsageError(`--event-id must be a UUID, got "${eventId}".`);
    }
    return {
      command,
      topic: singleTopic(t.positional),
      eventId: eventId?.toLowerCase(),
      dryRun: t.booleans.has('--dry-run'),
      allowStale: t.booleans.has('--allow-stale'),
    };
  }
  throw new CliUsageError(`Unknown command: ${command}`);
}
