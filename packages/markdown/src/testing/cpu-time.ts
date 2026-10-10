/**
 * CPU time (user + system, ms) spent by this process since `start`.
 *
 * The performance specs guard against quadratic blow-ups, which burn CPU (an unguarded worst
 * case is 14-15 s). Wall-clock time is the wrong measure for that: under a full parallel turbo
 * run the same linear input took 15x longer on the clock (0.5 s -> 8 s) purely from contention.
 * The parser is single-threaded and vitest runs each spec file in its own process (pool: forks),
 * so this process's CPU time measures the work itself.
 */
export function cpuStart(): NodeJS.CpuUsage {
  return process.cpuUsage();
}

export function cpuMsSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}
