import { randomInt } from 'node:crypto';

/**
 * RFC 5737 documentation ranges (TEST-NET-1/2/3): never routed, never a real user. The e2e
 * sweep sends one of these as `X-Client-IP`, so every per-IP rate-limit key it touches is
 * recognisably a test key.
 */
const TEST_NETS = ['192.0.2', '198.51.100', '203.0.113'] as const;
const HOSTS_PER_NET = 254; // .1 – .254
export const TEST_NET_POOL_SIZE = TEST_NETS.length * HOSTS_PER_NET;

export function testNetIp(index: number): string {
  const i = ((index % TEST_NET_POOL_SIZE) + TEST_NET_POOL_SIZE) % TEST_NET_POOL_SIZE;
  const net = TEST_NETS[Math.floor(i / HOSTS_PER_NET)];
  return `${net ?? TEST_NETS[0]}.${(i % HOSTS_PER_NET) + 1}`;
}

/**
 * Hands out distinct TEST-NET addresses for one test file: a random starting point, then
 * sequential, so no two tests of the file share an address (the pool is far larger than any
 * file). Addresses are reused across runs, so the harness clears their per-IP rate-limit keys
 * before handing one out (see `ipRateLimitKeys`): an earlier run can never leak into this one.
 */
export class TestNetIpAllocator {
  private next = randomInt(TEST_NET_POOL_SIZE);
  private readonly issued = new Set<string>();

  allocate(): string {
    if (this.issued.size >= TEST_NET_POOL_SIZE) {
      throw new Error('TestNetIpAllocator: the TEST-NET pool is exhausted for this file');
    }
    let ip = testNetIp(this.next++);
    while (this.issued.has(ip)) ip = testNetIp(this.next++);
    this.issued.add(ip);
    return ip;
  }

  /** Every address handed out so far (for cleanup). */
  all(): string[] {
    return [...this.issued];
  }
}

/** The per-IP Redis rate-limit keys of design §6 ("Redis keys"). */
export function ipRateLimitKeys(ip: string): string[] {
  return [`rl:login:ip:${ip}`, `rl:signup:ip:${ip}`, `rl:forgot:ip:${ip}`];
}
