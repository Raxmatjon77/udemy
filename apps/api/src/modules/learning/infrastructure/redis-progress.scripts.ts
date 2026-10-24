import { createHash } from 'node:crypto';
import type { RedisClient } from '../../../shared/redis';

/**
 * The Redis write-behind buffer (design D2, §6 "Redis keys"):
 *
 * | key                    | type   | content                                                      | TTL  |
 * | ---------------------- | ------ | ------------------------------------------------------------ | ---- |
 * | `lp:{u}:{l}`           | hash   | c course, a asset, d duration, p position, hb last heartbeat ms, f first watched ms | 7 d |
 * | `lpc:{u}:{l}`          | string | coverage bitmap (SETBIT offset = bucket, MSB-first)          | 7 d  |
 * | `la:{u}:{c}`           | hash   | l last lecture, t accessed-at ms (the resume pointer)        | 7 d  |
 * | `lp:dirty`             | zset   | `p:{u}:{l}` / `a:{u}:{c}` scored by first-dirty ms           | none |
 * | `lp:proc:{runId}`      | zset   | one flush run's claimed members (same scores)                | none |
 * | `lp:procs`             | zset   | runIds of unacked claims, scored by claim ms                 | none |
 *
 * The scripts build member keys from ARGV (the prefix), so the buffer must live on ONE Redis
 * node (no cluster), as the rest of the api's Redis use does. Ids are lowercase uuids.
 */
export class RedisProgressKeys {
  /** `prefix` isolates integration tests; production uses ''. */
  constructor(readonly prefix: string = '') {}

  progress(userId: string, lectureId: string): string {
    return `${this.prefix}lp:${userId}:${lectureId}`;
  }
  coverage(userId: string, lectureId: string): string {
    return `${this.prefix}lpc:${userId}:${lectureId}`;
  }
  activity(userId: string, courseId: string): string {
    return `${this.prefix}la:${userId}:${courseId}`;
  }
  get dirty(): string {
    return `${this.prefix}lp:dirty`;
  }
  get runs(): string {
    return `${this.prefix}lp:procs`;
  }
  processing(runId: string): string {
    return `${this.prefix}lp:proc:${runId}`;
  }
  progressMember(userId: string, lectureId: string): string {
    return `p:${userId}:${lectureId}`;
  }
  activityMember(userId: string, courseId: string): string {
    return `a:${userId}:${courseId}`;
  }
}

/** Buffer keys expire after a week without heartbeats (design §6). */
export const PROGRESS_KEY_TTL_SECONDS = 7 * 24 * 3600;

interface LuaScript {
  readonly source: string;
  readonly sha1: string;
}

function script(lines: readonly string[]): LuaScript {
  const source = lines.join('\n');
  return { source, sha1: createHash('sha1').update(source).digest('hex') };
}

/** The `record` script's compare-and-set failure reply. */
export const RECORD_CAS_FAILED = -1;

/**
 * Atomic Lua scripts. Every reply array is fixed-stride and never contains nil (a Lua nil
 * would truncate the array): missing values are ''.
 */
export const PROGRESS_SCRIPTS = {
  /**
   * One heartbeat. KEYS: 1 lp, 2 lpc, 3 dirty, 4 la.
   * ARGV: 1 expected hb ('' = no hash yet), 2 courseId, 3 assetId, 4 duration, 5 position,
   *       6 now ms, 7 ttl s, 8 progress member, 9 activity member, 10 lectureId,
   *       11 seed flag ('1' = seed the bitmap from ARGV 12), 12 seed bytes, 13 seed first ms,
   *       14 seed last heartbeat ms, 15.. bucket spans as (first, last) pairs.
   * Compare-and-set on `hb`: the caller computed the plausibility budget from that value; if a
   * concurrent heartbeat moved it, nothing is written and RECORD_CAS_FAILED is returned (the
   * caller re-reads and retries). A different asset or duration resets the bitmap (D3). `hb` is
   * monotonic per key (max), so the flush's last-write-wins never goes backwards.
   * Returns the covered bucket count.
   */
  record: script([
    "local hb = redis.call('HGET', KEYS[1], 'hb')",
    "if (hb or '') ~= ARGV[1] then return " + String(RECORD_CAS_FAILED) + ' end',
    'local now = tonumber(ARGV[6])',
    'local first = ARGV[6]',
    'local lastHb = 0',
    'if hb then',
    '  lastHb = tonumber(hb)',
    "  local h = redis.call('HMGET', KEYS[1], 'a', 'd', 'f')",
    '  if h[1] ~= ARGV[3] or h[2] ~= ARGV[4] then',
    "    redis.call('DEL', KEYS[2])",
    '  elseif h[3] then',
    '    first = h[3]',
    '  end',
    'else',
    "  redis.call('DEL', KEYS[2])",
    "  if ARGV[11] == '1' then",
    "    redis.call('SET', KEYS[2], ARGV[12])",
    '    first = ARGV[13]',
    '    lastHb = tonumber(ARGV[14])',
    '  end',
    'end',
    'if lastHb > now then now = lastHb end',
    'for i = 15, #ARGV, 2 do',
    '  for b = tonumber(ARGV[i]), tonumber(ARGV[i + 1]) do',
    "    redis.call('SETBIT', KEYS[2], b, 1)",
    '  end',
    'end',
    "redis.call('HSET', KEYS[1], 'c', ARGV[2], 'a', ARGV[3], 'd', ARGV[4], 'p', ARGV[5], 'hb', tostring(now), 'f', first)",
    "redis.call('EXPIRE', KEYS[1], ARGV[7])",
    "if redis.call('EXISTS', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], ARGV[7]) end",
    "redis.call('ZADD', KEYS[3], 'NX', ARGV[6], ARGV[8])",
    "redis.call('HSET', KEYS[4], 'l', ARGV[10], 't', tostring(now))",
    "redis.call('EXPIRE', KEYS[4], ARGV[7])",
    "redis.call('ZADD', KEYS[3], 'NX', ARGV[6], ARGV[9])",
    "return redis.call('BITCOUNT', KEYS[2])",
  ]),

  /**
   * Resume pointer only. KEYS: 1 la, 2 dirty. ARGV: 1 lectureId, 2 now ms, 3 ttl s, 4 member.
   * Monotonic: an older time never replaces a newer one.
   */
  touch: script([
    "local t = tonumber(redis.call('HGET', KEYS[1], 't') or '0')",
    'local now = tonumber(ARGV[2])',
    'if t > now then return 0 end',
    "redis.call('HSET', KEYS[1], 'l', ARGV[1], 't', ARGV[2])",
    "redis.call('EXPIRE', KEYS[1], ARGV[3])",
    "redis.call('ZADD', KEYS[2], 'NX', ARGV[2], ARGV[4])",
    'return 1',
  ]),

  /**
   * The flush claim. KEYS: 1 dirty, 2 runs, 3 processing set of this run.
   * ARGV: 1 limit, 2 now ms, 3 runId, 4 key prefix.
   * Pops the oldest members, records them (with their scores) in the processing set, registers
   * the run, and returns stride-8 records:
   *   progress: member, c, a, d, p, hb, f, bitmap
   *   activity: member, l, t, '', '', '', '', ''
   */
  claim: script([
    "local items = redis.call('ZPOPMIN', KEYS[1], tonumber(ARGV[1]))",
    'if #items == 0 then return {} end',
    'local out = {}',
    'for i = 1, #items, 2 do',
    '  local m = items[i]',
    "  redis.call('ZADD', KEYS[3], items[i + 1], m)",
    '  local rest = string.sub(m, 3)',
    '  out[#out + 1] = m',
    "  if string.sub(m, 1, 2) == 'p:' then",
    "    local h = redis.call('HMGET', ARGV[4] .. 'lp:' .. rest, 'c', 'a', 'd', 'p', 'hb', 'f')",
    "    for j = 1, 6 do out[#out + 1] = h[j] or '' end",
    "    out[#out + 1] = redis.call('GET', ARGV[4] .. 'lpc:' .. rest) or ''",
    '  else',
    "    local h = redis.call('HMGET', ARGV[4] .. 'la:' .. rest, 'l', 't')",
    "    out[#out + 1] = h[1] or ''",
    "    out[#out + 1] = h[2] or ''",
    "    for j = 1, 5 do out[#out + 1] = '' end",
    '  end',
    'end',
    "redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])",
    'return out',
  ]),

  /**
   * Re-queue claims. KEYS: 1 dirty, 2 runs. ARGV: 1 key prefix, 2 mode ('run' | 'stale'),
   * 3 runId (run) or cutoff ms (stale). Members go back with ZADD NX and their original score
   * (a newer heartbeat that re-dirtied a member keeps its own score). Returns the members moved.
   */
  requeue: script([
    'local runs',
    "if ARGV[2] == 'run' then runs = { ARGV[3] }",
    "else runs = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[3]) end",
    'local moved = 0',
    'for _, run in ipairs(runs) do',
    "  local key = ARGV[1] .. 'lp:proc:' .. run",
    "  local items = redis.call('ZRANGE', key, 0, -1, 'WITHSCORES')",
    '  for i = 1, #items, 2 do',
    "    moved = moved + redis.call('ZADD', KEYS[1], 'NX', items[i + 1], items[i])",
    '  end',
    "  redis.call('DEL', key)",
    "  redis.call('ZREM', KEYS[2], run)",
    'end',
    'return moved',
  ]),
} as const;

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOSCRIPT');
}

/** EVALSHA, falling back to EVAL once when the script cache is empty (Redis restart). */
export async function runScript(
  redis: RedisClient,
  lua: LuaScript,
  keys: readonly string[],
  args: readonly (string | Buffer)[],
): Promise<unknown> {
  try {
    return await redis.evalsha(lua.sha1, keys.length, ...keys, ...args);
  } catch (error) {
    if (!isNoScriptError(error)) throw error;
    return redis.eval(lua.source, keys.length, ...keys, ...args);
  }
}

/** Like `runScript`, but bulk-string replies come back as Buffers (binary bitmaps). */
export async function runScriptBuffer(
  redis: RedisClient,
  lua: LuaScript,
  keys: readonly string[],
  args: readonly (string | Buffer)[],
): Promise<unknown> {
  const rest = [String(keys.length), ...keys, ...args];
  try {
    return await redis.callBuffer('EVALSHA', [lua.sha1, ...rest]);
  } catch (error) {
    if (!isNoScriptError(error)) throw error;
    return redis.callBuffer('EVAL', [lua.source, ...rest]);
  }
}
