import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A canonical UUID string (anything else would make Postgres raise 22P02 on a uuid cast). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * A stable id for one `enrollment_transitions` row, whose key is `(enrollment_id, seq)`: the
 * HTTP contract (`EnrollmentTransitionSchema.id`) wants a UUID. Name-based (RFC 9562 v5, SHA-1)
 * with the enrollment id as the namespace, so the same row always gets the same id and ids
 * never collide across enrollments.
 */
export function transitionId(enrollmentId: string, seq: number): string {
  const namespace = Buffer.from(enrollmentId.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespace).update(`enrollment-transition:${seq}`).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
