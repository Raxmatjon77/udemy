import { describe, expect, it } from 'vitest';
import { CliUsageError } from '../cli-usage.error';
import { parseDlqArgs } from './dlq-args';

const ID = '0199B0A4-5C3E-7D10-8F00-2A1B3C4D5E6F';

describe('parseDlqArgs', () => {
  it('parses dlq:list with defaults and with --limit/--preview in both flag styles', () => {
    expect(parseDlqArgs('dlq:list', ['identity.user.dlq'])).toEqual({
      command: 'dlq:list',
      topic: 'identity.user.dlq',
      limit: 20,
      previewChars: 200,
    });
    expect(
      parseDlqArgs('dlq:list', ['--limit', '5', 'identity.user.dlq', '--preview=50']),
    ).toMatchObject({ limit: 5, previewChars: 50 });
  });

  it('parses dlq:replay --event-id (lower-cased) and --all with the boolean flags', () => {
    expect(parseDlqArgs('dlq:replay', ['system.ping.dlq', '--event-id', ID])).toEqual({
      command: 'dlq:replay',
      topic: 'system.ping.dlq',
      eventId: ID.toLowerCase(),
      dryRun: false,
      allowStale: false,
    });
    expect(
      parseDlqArgs('dlq:replay', ['system.ping.dlq', '--all', '--dry-run', '--allow-stale']),
    ).toMatchObject({ eventId: undefined, dryRun: true, allowStale: true });
  });

  it.each([
    ['dlq:list', [], /topic is required/],
    ['dlq:list', ['a.dlq', 'b.dlq'], /Unexpected argument/],
    ['dlq:list', ['a.dlq', '--limit', '0'], /--limit must be an integer in 1..1000/],
    ['dlq:list', ['a.dlq', '--limit', '1001'], /--limit/],
    ['dlq:list', ['a.dlq', '--limit'], /--limit needs a value/],
    ['dlq:list', ['a.dlq', '--all'], /Unknown argument: --all/],
    ['dlq:replay', ['a.dlq'], /exactly one of --event-id <uuid> or --all/],
    ['dlq:replay', ['a.dlq', '--all', '--event-id', ID], /exactly one/],
    ['dlq:replay', ['a.dlq', '--event-id', 'not-a-uuid'], /must be a UUID/],
    ['dlq:replay', ['a.dlq', '--all=yes'], /takes no value/],
    ['dlq:replay', ['a.dlq', '--event-id', ID, '--event-id', ID], /given twice/],
    ['dlq:purge', ['a.dlq'], /Unknown command: dlq:purge/],
  ] as const)('%s %j is a usage error', (command, argv, message) => {
    const run = (): unknown => parseDlqArgs(command, argv);
    expect(run).toThrow(CliUsageError);
    expect(run).toThrow(message);
  });
});
