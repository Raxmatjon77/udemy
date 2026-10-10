import { EnvValidationError } from '@udemy/nest-common';
import { KafkaDlqClient } from '../messaging/kafka/kafka-dlq.client';
import { loadCliEnv } from './cli-env';
import { CliUsageError } from './cli-usage.error';
import { DLQ_LIST_COMMAND, DLQ_USAGE, parseDlqArgs } from './dlq/dlq-args';
import { CliCommandError, type CliOutput, listDlq, replayDlq } from './dlq/dlq-commands';

/**
 * Entry point of `pnpm --filter @udemy/worker cli <command> ...` (dist/cli/main.js; run
 * `pnpm --filter @udemy/worker build` first). Unlike the api's CLI it does NOT boot the
 * WorkerModule: that would start the consumer in the shared `udemy-worker` group. It reads only
 * the Kafka env and talks to Kafka directly, one command per invocation:
 * 0 = success, 1 = the command failed, 2 = bad command line.
 */
async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${DLQ_USAGE}\n`);
    return command === undefined ? 2 : 0;
  }
  // Validate the command line before connecting anywhere.
  const args = parseDlqArgs(command, rest);
  const env = loadCliEnv();

  const out: CliOutput = {
    line: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    note: (message) => process.stderr.write(`${message}\n`),
  };
  const client = new KafkaDlqClient({
    brokers: env.KAFKA_BROKERS,
    clientId: `${env.KAFKA_CLIENT_ID}-cli`,
    groupIdPrefix: `${env.KAFKA_CLIENT_ID}-dlq-cli`,
    forbiddenGroupIds: [env.KAFKA_GROUP_ID],
  });
  try {
    if (args.command === DLQ_LIST_COMMAND) {
      await listDlq(client, args, out);
    } else {
      await replayDlq(
        client,
        {
          ...args,
          processedRetentionDays: env.PROCESSED_EVENTS_RETENTION_DAYS,
          now: new Date(),
        },
        out,
      );
    }
    return 0;
  } finally {
    await client.close();
  }
}

function report(error: unknown): number {
  if (error instanceof CliUsageError) {
    process.stderr.write(`${error.message}\n\n${DLQ_USAGE}\n`);
    return 2;
  }
  if (error instanceof CliCommandError || error instanceof EnvValidationError) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    return 1;
  }
  process.stderr.write(
    `Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.exitCode = report(error);
  });
