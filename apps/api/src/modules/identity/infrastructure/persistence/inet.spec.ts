import { describe, expect, it } from 'vitest';
import { toInet, toInetOrNull, UNSPECIFIED_IP } from './inet';

describe('inet helpers', () => {
  it('passes literal IPv4/IPv6 addresses through', () => {
    expect(toInet('203.0.113.7')).toBe('203.0.113.7');
    expect(toInet('2001:db8::1')).toBe('2001:db8::1');
    expect(toInetOrNull('::1')).toBe('::1');
  });

  it("never lets ClientIpResolver's 'unknown' (or garbage) reach an inet column", () => {
    expect(toInet('unknown')).toBe(UNSPECIFIED_IP);
    expect(toInet('1.2.3.4, 5.6.7.8')).toBe(UNSPECIFIED_IP);
    expect(toInetOrNull('unknown')).toBeNull();
    expect(toInetOrNull(undefined)).toBeNull();
  });
});
